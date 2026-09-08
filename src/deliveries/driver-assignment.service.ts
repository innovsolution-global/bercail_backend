import { Injectable, Logger } from '@nestjs/common';
import { AccountStatus, DeliveryStatus, Prisma } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { distanceKm, isValidCoordinates, type Coordinates } from '../common/utils/geo.util';
import { toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { DELIVERY_ACTIVE } from './delivery-status';

/**
 * Choix du livreur.
 *
 * Le service ne décide pas à la place du gestionnaire : il lui propose
 * une liste ordonnée (disponibilité, proximité, charge, note) et vérifie
 * que le livreur retenu peut effectivement prendre la course.
 *
 * Un livreur est éligible s'il est actif, en ligne, disponible, et non
 * suspendu. Ces trois vérifications sont refaites au moment de
 * l'assignation : entre l'affichage de la liste et le clic, il a pu se
 * mettre hors ligne.
 */
@Injectable()
export class DriverAssignmentService {
  private readonly logger = new Logger(DriverAssignmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Livreurs proposables pour une commande donnée. */
  async assignable(options: { orderId?: string; zone?: string; limit?: number } = {}) {
    const where: Prisma.DriverProfileWhereInput = {
      isOnline: true,
      isAvailable: true,
      user: { status: AccountStatus.ACTIVE, deletedAt: null },
      ...(options.zone && options.zone !== 'all' ? { zone: options.zone } : {}),
    };

    const drivers = await this.prisma.driverProfile.findMany({
      where,
      include: {
        user: { select: { firstName: true, lastName: true, phone: true, avatarUrl: true } },
        _count: { select: { deliveries: { where: { status: { in: DELIVERY_ACTIVE } } } } },
      },
      take: options.limit ?? 50,
    });

    const target = options.orderId ? await this.orderCoordinates(options.orderId) : null;

    return drivers
      .map((driver) => {
        const position: Coordinates | null = isValidCoordinates({
          latitude: driver.lastLatitude ?? undefined,
          longitude: driver.lastLongitude ?? undefined,
        })
          ? { latitude: driver.lastLatitude!, longitude: driver.lastLongitude! }
          : null;

        return {
          id: driver.id,
          fullName: `${driver.user.firstName} ${driver.user.lastName}`.trim(),
          phone: driver.user.phone,
          avatarUrl: driver.user.avatarUrl,
          zone: driver.zone,
          vehicleType: toWire(driver.vehicleType),
          rating: driver.rating,
          activeDeliveries: driver._count.deliveries,
          /** Distance jusqu'au client ; null si la position est inconnue. */
          distanceKm: target && position ? distanceKm(position, target) : null,
          lastSeenAt: driver.lastSeenAt?.toISOString() ?? null,
        };
      })
      .sort((left, right) => {
        // Priorité : le moins chargé, puis le plus proche, puis le mieux noté.
        if (left.activeDeliveries !== right.activeDeliveries) {
          return left.activeDeliveries - right.activeDeliveries;
        }
        if (left.distanceKm !== null && right.distanceKm !== null) {
          return left.distanceKm - right.distanceKm;
        }
        if (left.distanceKm === null && right.distanceKm !== null) return 1;
        if (left.distanceKm !== null && right.distanceKm === null) return -1;
        return right.rating - left.rating;
      });
  }

  /**
   * Vérifie qu'un livreur peut recevoir une course.
   * Appelée dans la transaction d'assignation, jamais avant.
   */
  async assertAssignable(driverId: string, client: Prisma.TransactionClient = this.prisma) {
    const driver = await client.driverProfile.findUnique({
      where: { id: driverId },
      include: { user: { select: { status: true, deletedAt: true, firstName: true, lastName: true } } },
    });

    if (!driver || driver.user.deletedAt) {
      throw AppException.notFound('Livreur introuvable.');
    }

    if (driver.user.status === AccountStatus.SUSPENDED) {
      throw AppException.conflict(
        ERROR_CODES.DRIVER_SUSPENDED,
        'Ce livreur est suspendu : il ne peut pas recevoir de course.',
      );
    }

    if (driver.user.status !== AccountStatus.ACTIVE) {
      throw AppException.conflict(
        ERROR_CODES.DRIVER_UNAVAILABLE,
        "Ce compte livreur n'est pas actif.",
      );
    }

    if (!driver.isOnline) {
      throw AppException.conflict(
        ERROR_CODES.DRIVER_UNAVAILABLE,
        `${driver.user.firstName} n'est pas en ligne actuellement.`,
      );
    }

    return driver;
  }

  /** Nombre de courses en cours pour un livreur. */
  async activeCount(driverId: string, client: Prisma.TransactionClient = this.prisma): Promise<number> {
    return client.delivery.count({
      where: { driverId, status: { in: DELIVERY_ACTIVE } },
    });
  }

  /** Coordonnées de livraison figées dans la commande. */
  private async orderCoordinates(orderId: string): Promise<Coordinates | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { addressSnapshot: true },
    });

    const snapshot = order?.addressSnapshot as Prisma.JsonObject | null | undefined;
    if (!snapshot) return null;

    const latitude = snapshot.latitude as number | null;
    const longitude = snapshot.longitude as number | null;

    return isValidCoordinates({ latitude: latitude ?? undefined, longitude: longitude ?? undefined })
      ? { latitude: latitude!, longitude: longitude! }
      : null;
  }

  /**
   * Suggestion automatique : le meilleur candidat.
   * Utilisée par l'assignation « au plus proche » ; le gestionnaire peut
   * toujours choisir quelqu'un d'autre.
   */
  async suggest(orderId: string): Promise<string | null> {
    const candidates = await this.assignable({ orderId, limit: 10 });
    return candidates[0]?.id ?? null;
  }

  /** Libère un livreur si plus aucune course active ne le mobilise. */
  async refreshAvailability(
    driverId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const active = await client.delivery.count({
      where: { driverId, status: { in: DELIVERY_ACTIVE } },
    });

    await client.driverProfile.update({
      where: { id: driverId },
      data: { isAvailable: active === 0 },
    });
  }

  /** Statut agrégé affiché dans le back-office. */
  workState(driver: {
    user: { status: AccountStatus };
    isAvailable: boolean;
  }): 'available' | 'busy' | 'suspended' {
    if (driver.user.status === AccountStatus.SUSPENDED) return 'suspended';
    return driver.isAvailable ? 'available' : 'busy';
  }

  /** Statuts de livraison considérés comme actifs (réexporté par commodité). */
  static get activeStatuses(): DeliveryStatus[] {
    return DELIVERY_ACTIVE;
  }
}
