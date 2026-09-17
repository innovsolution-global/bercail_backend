import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { TokenService } from '../../auth/token.service';
import { PrismaService } from '../../database/prisma.service';
import { DELIVERY_ACTIVE } from '../../deliveries/delivery-status';
import { SettingsService } from '../../settings/settings.service';
import { OrdersService } from '../../orders/orders.service';
import { IdempotencyService } from '../services/idempotency.service';

/**
 * Entretien courant de la base.
 *
 * Trois tâches, toutes idempotentes et sans effet métier :
 *  - purger les jetons expirés et les clés d'idempotence ;
 *  - appliquer la rétention configurée sur le journal d'audit ;
 *  - remettre hors ligne les livreurs dont l'application ne donne plus
 *    signe de vie (téléphone éteint, application fermée).
 *
 * Les positions GPS anciennes sont également purgées : conserver
 * indéfiniment la trace des déplacements d'une personne n'a aucune
 * justification métier une fois la course archivée.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: SettingsService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Une commande en ligne qui n'a pas été payée en 45 minutes est
   * annulée.
   *
   * Le client a eu le temps de revenir sur la page de l'opérateur, de
   * réessayer, de changer de moyen. Au-delà, la commande n'aura pas
   * lieu — et la laisser « en attente » pour toujours encombrait sa
   * liste, celle du restaurant, et retenait un coupon.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireUnpaidOrders(): Promise<void> {
    const count = await this.orders.expireUnpaid(45);
    if (count > 0) {
      this.logger.log(`${count} commande(s) en ligne annulée(s) faute de paiement.`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpiredTokens(): Promise<void> {
    const [refresh, idempotency, authTokens] = await Promise.all([
      this.tokens.purgeExpired(),
      this.idempotency.purgeExpired(),
      this.prisma.authToken.deleteMany({
        where: { expiresAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
      }),
    ]);

    if (refresh + idempotency + authTokens.count > 0) {
      this.logger.log(
        `Purge : ${refresh} refresh token(s), ${authTokens.count} jeton(s) d'activation, ${idempotency} clé(s) d'idempotence.`,
      );
    }
  }

  /**
   * Un livreur qui n'a pas donné de nouvelles depuis cinq minutes est
   * repassé hors ligne : sans quoi le back-office lui attribuerait des
   * courses qu'il ne verrait jamais.
   *
   * Sa présence est celle de son application : elle se déclare à
   * l'ouverture et bat toutes les minutes tant qu'elle est ouverte
   * (voir `DriverPresence` côté mobile). Trente minutes, c'était le temps
   * qu'un téléphone éteint restait « en ligne » au back-office.
   *
   * Un livreur en course est épargné : sa position, envoyée pendant la
   * livraison, tient lieu de nouvelles — et un GPS qui décroche sous un
   * toit ne doit pas le faire disparaître au milieu d'une livraison.
   */
  @Cron('*/2 * * * *')
  async releaseStaleDrivers(): Promise<void> {
    const threshold = new Date(Date.now() - 5 * 60 * 1000);

    const result = await this.prisma.driverProfile.updateMany({
      where: {
        isOnline: true,
        OR: [{ lastSeenAt: { lt: threshold } }, { lastSeenAt: null }],
        deliveries: { none: { status: { in: DELIVERY_ACTIVE } } },
      },
      data: { isOnline: false, isAvailable: false },
    });

    if (result.count > 0) {
      this.logger.warn(`${result.count} livreur(s) repassé(s) hors ligne pour inactivité.`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async applyRetention(): Promise<void> {
    const settings = await this.settings.getSystemSettings();

    const removedLogs = await this.audit.purgeOlderThan(settings.auditRetentionDays);

    // Les positions GPS ne sont conservées que 30 jours.
    const removedLocations = await this.prisma.driverLocation.deleteMany({
      where: { recordedAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
    });

    /*
     * Journal de synchronisation.
     *
     * Seules les écritures transmises sont purgées, et après un délai
     * confortable : une écriture en attente doit survivre à une coupure de
     * plusieurs jours, et un conflit non résolu à l'examen qu'il appelle.
     */
    const removedSync = await this.prisma.syncOutbox.deleteMany({
      where: {
        status: SyncStatus.SENT,
        syncedAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    });

    // Le registre des écritures appliquées peut suivre : passé ce délai,
    // le pair ne rejouera plus un lot aussi ancien.
    const removedApplied = await this.prisma.syncApplied.deleteMany({
      where: { appliedAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
    });

    this.logger.log(
      `Rétention appliquée : ${removedLogs} entrée(s) d'audit, ${removedLocations.count} position(s) GPS, ` +
        `${removedSync.count + removedApplied.count} ligne(s) de synchronisation supprimée(s).`,
    );
  }
}
