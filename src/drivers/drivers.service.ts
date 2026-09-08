import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  AuthTokenPurpose,
  DeliveryStatus,
  DriverProfile,
  NotificationType,
  Prisma,
  Role,
  User,
  VehicleType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { randomPassword, randomToken, sha256 } from '../common/utils/crypto.util';
import { generateDriverCode } from '../common/utils/reference.util';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { MailService } from '../mail/mail.service';
import {
  accountCreatedWithActivationLink,
  accountCreatedWithPassword,
} from '../mail/mail.templates';
import { DELIVERY_ACTIVE } from '../deliveries/delivery-status';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import type {
  CreateDriverDto,
  DriverQueryDto,
  UpdateAccountStatusDto,
  UpdateDriverDto,
} from './dto/driver.dto';

type DriverRow = DriverProfile & {
  user: Pick<
    User,
    'id' | 'firstName' | 'lastName' | 'email' | 'phone' | 'avatarUrl' | 'status' | 'createdAt'
  >;
  _count?: { deliveries: number };
};

/**
 * Livreurs.
 *
 * Point structurant du contrat : **un livreur ne s'inscrit pas**. Son
 * compte est créé ici, par un ADMIN ou un SUPER_ADMIN, avec un mot de
 * passe temporaire ou un lien d'activation. La route publique
 * `/auth/register` ne peut pas créer ce rôle.
 */
@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly scope: RestaurantScopeService,
  ) {}

  // ─────────────────────────────── Lecture ────────────────────────────────

  async list(query: DriverQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.DriverProfileWhereInput = { user: { deletedAt: null } };

    const status = parseEnum(AccountStatus, query.status);
    if (status) where.user = { ...(where.user as object), status };

    if (query.availability === 'online') where.isOnline = true;
    if (query.availability === 'offline') where.isOnline = false;
    if (query.zone && query.zone !== 'all') where.zone = query.zone;

    if (query.search) {
      where.OR = [
        { driverCode: { contains: query.search, mode: 'insensitive' } },
        { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
        { user: { phone: { contains: query.search } } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.driverProfile.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              avatarUrl: true,
              status: true,
              createdAt: true,
            },
          },
          _count: { select: { deliveries: { where: { status: { in: DELIVERY_ACTIVE } } } } },
        },
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.driverProfile.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);
  }

  async findOne(id: string) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { OR: [{ id }, { userId: id }], user: { deletedAt: null } },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            status: true,
            createdAt: true,
          },
        },
        _count: { select: { deliveries: { where: { status: { in: DELIVERY_ACTIVE } } } } },
      },
    });

    if (!driver) throw AppException.notFound('Livreur introuvable.');

    return {
      ...this.toDto(driver),
      stats: await this.stats(driver.id),
      lastKnownPosition:
        driver.lastLatitude !== null && driver.lastLongitude !== null
          ? {
              latitude: driver.lastLatitude,
              longitude: driver.lastLongitude,
              updatedAt: driver.lastPositionAt?.toISOString() ?? null,
            }
          : null,
      lastSeenAt: driver.lastSeenAt?.toISOString() ?? null,
    };
  }

  /**
   * Statistiques d'un livreur.
   * Calculées en base par agrégation : on ne charge jamais l'historique
   * complet des courses en mémoire pour en faire la moyenne.
   */
  async stats(driverProfileId: string) {
    const [profile, failed, monthlyRevenue] = await Promise.all([
      this.prisma.driverProfile.findUnique({ where: { id: driverProfileId } }),
      this.prisma.delivery.count({
        where: { driverId: driverProfileId, status: DeliveryStatus.FAILED },
      }),
      this.prisma.order.aggregate({
        _sum: { deliveryFee: true },
        where: {
          delivery: { driverId: driverProfileId, status: DeliveryStatus.DELIVERED },
          deliveredAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
        },
      }),
    ]);

    if (!profile) throw AppException.notFound('Livreur introuvable.');

    const completed = profile.completedDeliveries;
    const attempted = completed + failed;

    return {
      completedDeliveries: completed,
      cancelledDeliveries: failed,
      averageMinutes: completed > 0 ? Math.round(profile.totalDeliveryMinutes / completed) : 0,
      successRate: attempted > 0 ? Math.round((completed / attempted) * 100) : 100,
      totalDistanceKm: Math.round(profile.totalDistanceMeters / 100) / 10,
      earningsThisMonth: monthlyRevenue._sum.deliveryFee ?? 0,
    };
  }

  async zones(): Promise<string[]> {
    const rows = await this.prisma.driverProfile.findMany({
      distinct: ['zone'],
      select: { zone: true },
      orderBy: { zone: 'asc' },
    });
    return rows.map((row) => row.zone);
  }

  // ─────────────────────────────── Création ───────────────────────────────

  /**
   * Crée un compte livreur.
   *
   * Deux modes :
   *  - mot de passe temporaire : renvoyé une seule fois au gestionnaire,
   *    jamais stocké en clair, à changer obligatoirement à la première
   *    connexion ;
   *  - lien d'activation : le livreur choisit son mot de passe, le compte
   *    reste PENDING jusque-là.
   */
  async create(dto: CreateDriverDto, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { email: true },
    });

    if (existing) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        existing.email === dto.email
          ? 'Cette adresse e-mail est déjà utilisée.'
          : 'Ce numéro de téléphone est déjà utilisé.',
      );
    }

    const mode = dto.credentialMode ?? 'temporary_password';

    // Le mot de passe choisi par le back-office passe par les mêmes règles de
    // robustesse que celui qu'un compte se donne lui-même.
    if (mode === 'temporary_password' && dto.password) {
      this.passwords.validate(dto.password);
    }

    const temporaryPassword =
      mode === 'temporary_password' ? (dto.password ?? randomPassword(12)) : randomPassword(24);
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const backOfficeUrl = (this.config.get<string>('mail.backOfficeUrl') ?? '').replace(/\/$/, '');
    // Faux avec le pilote `noop` : rien n'a été expédié, et le back-office
    // doit alors afficher les accès au lieu d'annoncer un envoi.
    let emailSent = false;
    const activationToken = mode === 'activation_link' ? randomToken() : null;

    const count = await this.prisma.driverProfile.count();

    const created = await this.prisma.transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          restaurantId: this.scope.resolve(dto.restaurantId),
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          role: Role.DRIVER,
          // Mot de passe temporaire : le compte est utilisable tout de suite,
          // mais bloqué sur le changement de mot de passe.
          status: mode === 'temporary_password' ? AccountStatus.ACTIVE : AccountStatus.PENDING,
          mustChangePassword: mode === 'temporary_password',
          createdById: actor.id,
          driverProfile: {
            create: {
              driverCode: await this.uniqueDriverCode(tx, count + 1),
              vehicleType: (parseEnum(VehicleType, dto.vehicleType) ?? VehicleType.MOTO) as VehicleType,
              plateNumber: dto.plateNumber,
              zone: dto.zone ?? 'Conakry',
            },
          },
        },
        include: { driverProfile: true },
      });

      if (activationToken) {
        const ttlHours = this.config.get<number>('security.activationTokenTtlHours') ?? 72;
        await tx.authToken.create({
          data: {
            userId: user.id,
            purpose: AuthTokenPurpose.ACCOUNT_ACTIVATION,
            tokenHash: sha256(activationToken),
            expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
          },
        });
      }

      // L'envoi participe à la transaction : si l'e-mail ne part pas, le
      // compte n'est pas créé.
      emailSent = await this.mail.send(
        activationToken
          ? accountCreatedWithActivationLink({
              to: user.email,
              fullName: `${user.firstName} ${user.lastName}`.trim(),
              activationUrl: `${backOfficeUrl}/reset-password?mode=activation&token=${encodeURIComponent(activationToken)}`,
              expiresInHours: this.config.get<number>('security.activationTokenTtlHours') ?? 72,
              role: 'livreur',
            })
          : accountCreatedWithPassword({
              to: user.email,
              fullName: `${user.firstName} ${user.lastName}`.trim(),
              password: temporaryPassword,
              loginUrl: `${backOfficeUrl}/login`,
              role: 'livreur',
            }),
      );

      return user;
    });

    await this.audit.record({
      actor,
      action: 'DRIVER_CREATE',
      module: 'drivers',
      entityType: 'User',
      entityId: created.id,
      newValue: {
        email: created.email,
        phone: created.phone,
        driverCode: created.driverProfile?.driverCode,
        credentialMode: mode,
      },
      context,
    });

    this.logger.log(`Livreur ${created.driverProfile?.driverCode} créé par ${actor.email}.`);

    const driver = await this.findOne(created.driverProfile!.id);

    // Les identifiants ne sont renvoyés qu'ici, à la création, et ne
    // seront plus jamais consultables.
    return {
      ...driver,
      credentials:
        mode === 'temporary_password'
          ? {
              mode,
              emailSent,
              temporaryPassword: emailSent ? undefined : temporaryPassword,
              note: emailSent
                ? 'Le mot de passe provisoire a été envoyé par e-mail au livreur. Il devra le changer à sa première connexion.'
                : "Envoi d'e-mails désactivé : communiquez ce mot de passe au livreur. Il devra le changer à sa première connexion.",
            }
          : {
              mode,
              emailSent,
              activationToken: emailSent ? undefined : activationToken,
              note: emailSent
                ? "Le lien d'activation a été envoyé par e-mail au livreur."
                : "Envoi d'e-mails désactivé : transmettez ce lien au livreur, il choisira lui-même son mot de passe.",
            },
    };
  }

  async update(id: string, dto: UpdateDriverDto, actor: AuthenticatedUser, context: RequestContext) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id },
      include: { user: true },
    });
    if (!driver) throw AppException.notFound('Livreur introuvable.');

    const { firstName, lastName, phone, avatarUrl, ...profileFields } = dto;

    await this.prisma.transaction(async (tx) => {
      if (firstName || lastName || phone || avatarUrl) {
        await tx.user.update({
          where: { id: driver.userId },
          data: { firstName, lastName, phone, avatarUrl },
        });
      }

      if (Object.keys(profileFields).length > 0) {
        const { vehicleType, ...rest } = profileFields;
        await tx.driverProfile.update({
          where: { id },
          data: {
            ...rest,
            ...(vehicleType
              ? { vehicleType: parseEnum(VehicleType, vehicleType) as VehicleType }
              : {}),
          },
        });
      }
    });

    await this.audit.record({
      actor,
      action: 'DRIVER_UPDATE',
      module: 'drivers',
      entityType: 'DriverProfile',
      entityId: id,
      oldValue: {
        firstName: driver.user.firstName,
        lastName: driver.user.lastName,
        phone: driver.user.phone,
        vehicleType: driver.vehicleType,
        zone: driver.zone,
        plateNumber: driver.plateNumber,
      },
      newValue: dto,
      context,
    });

    return this.findOne(id);
  }

  /**
   * Suspension / réactivation.
   *
   * Une suspension ferme immédiatement toutes les sessions du livreur :
   * son application se retrouve déconnectée, elle ne peut pas continuer
   * à travailler avec un jeton encore valide.
   */
  async setStatus(
    id: string,
    dto: UpdateAccountStatusDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id },
      include: { user: true },
    });
    if (!driver) throw AppException.notFound('Livreur introuvable.');

    const status = (parseEnum(AccountStatus, dto.status) ?? AccountStatus.ACTIVE) as AccountStatus;

    if (status === AccountStatus.SUSPENDED) {
      const active = await this.prisma.delivery.count({
        where: { driverId: id, status: { in: DELIVERY_ACTIVE } },
      });
      if (active > 0) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `Ce livreur a ${active} course(s) en cours. Réattribuez-les avant de le suspendre.`,
        );
      }
    }

    await this.prisma.transaction(async (tx) => {
      await tx.user.update({ where: { id: driver.userId }, data: { status } });
      await tx.driverProfile.update({
        where: { id },
        data:
          status === AccountStatus.ACTIVE
            ? { isAvailable: true }
            : { isOnline: false, isAvailable: false },
      });
    });

    if (status !== AccountStatus.ACTIVE) {
      await this.tokens.revokeAllForUser(driver.userId);
    }

    await this.notifications.notify({
      userId: driver.userId,
      type: NotificationType.SECURITY,
      title: status === AccountStatus.SUSPENDED ? 'Compte suspendu' : 'Statut de compte modifié',
      body:
        status === AccountStatus.SUSPENDED
          ? `Votre compte a été suspendu. ${dto.reason ?? ''}`.trim()
          : `Votre compte est désormais ${toWire(status)}.`,
    });

    await this.audit.record({
      actor,
      action: 'DRIVER_STATUS_UPDATE',
      module: 'drivers',
      entityType: 'User',
      entityId: driver.userId,
      oldValue: { status: driver.user.status },
      newValue: { status, reason: dto.reason ?? null },
      context,
    });

    return this.findOne(id);
  }

  /** Suppression logique — les livraisons passées restent consultables. */
  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id },
      include: { user: true },
    });
    if (!driver) throw AppException.notFound('Livreur introuvable.');

    const active = await this.prisma.delivery.count({
      where: { driverId: id, status: { in: DELIVERY_ACTIVE } },
    });
    if (active > 0) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        `Ce livreur a ${active} course(s) en cours : elles doivent être réattribuées d'abord.`,
      );
    }

    // Voir `AdminsService.remove` : `email` et `phone` sont uniques en base,
    // les conserver sur une ligne supprimée interdirait pour toujours de
    // recréer un compte pour cette personne.
    const releaseTag = `supprime-${Date.now()}`;

    await this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id: driver.userId },
        data: {
          deletedAt: new Date(),
          status: AccountStatus.INACTIVE,
          email: `${releaseTag}-${driver.user.email}`,
          phone: `${releaseTag}-${driver.user.phone}`,
        },
      });
      await tx.driverProfile.update({
        where: { id },
        data: { isOnline: false, isAvailable: false },
      });
    });

    await this.tokens.revokeAllForUser(driver.userId);

    await this.audit.record({
      actor,
      action: 'DRIVER_DELETE',
      module: 'drivers',
      entityType: 'User',
      entityId: driver.userId,
      oldValue: { email: driver.user.email, driverCode: driver.driverCode },
      context,
    });

    return { success: true };
  }

  /** Renvoie un nouveau lien d'activation à un livreur encore PENDING. */
  async resendActivation(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const driver = await this.prisma.driverProfile.findFirst({
      where: { id },
      include: { user: true },
    });
    if (!driver) throw AppException.notFound('Livreur introuvable.');

    if (driver.user.status !== AccountStatus.PENDING) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce compte est déjà activé.');
    }

    const token = randomToken();
    const ttlHours = this.config.get<number>('security.activationTokenTtlHours') ?? 72;

    await this.prisma.transaction(async (tx) => {
      await tx.authToken.updateMany({
        where: {
          userId: driver.userId,
          purpose: AuthTokenPurpose.ACCOUNT_ACTIVATION,
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      await tx.authToken.create({
        data: {
          userId: driver.userId,
          purpose: AuthTokenPurpose.ACCOUNT_ACTIVATION,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
        },
      });
    });

    await this.audit.record({
      actor,
      action: 'DRIVER_ACTIVATION_RESENT',
      module: 'drivers',
      entityType: 'User',
      entityId: driver.userId,
      context,
    });

    return { success: true, activationToken: token };
  }

  // ─────────────────────────── Espace livreur ─────────────────────────────

  /**
   * Passage en ligne / hors ligne.
   * Un livreur ne peut pas se déclarer disponible tant qu'il a une course
   * active : la disponibilité est déduite du travail en cours.
   */
  async updateAvailability(
    user: AuthenticatedUser,
    dto: { isOnline?: boolean; isAvailable?: boolean },
  ) {
    if (!user.driverProfileId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, 'Ce compte n’a pas de profil livreur.');
    }

    const active = await this.prisma.delivery.count({
      where: { driverId: user.driverProfileId, status: { in: DELIVERY_ACTIVE } },
    });

    const isOnline = dto.isOnline;
    const isAvailable =
      active > 0 ? false : (dto.isAvailable ?? (isOnline === false ? false : undefined));

    const profile = await this.prisma.driverProfile.update({
      where: { id: user.driverProfileId },
      data: {
        ...(isOnline !== undefined ? { isOnline } : {}),
        ...(isAvailable !== undefined ? { isAvailable } : {}),
        ...(isOnline === false ? { isAvailable: false } : {}),
        lastSeenAt: new Date(),
      },
    });

    this.realtime.driverStatusUpdated({
      driverProfileId: profile.id,
      isOnline: profile.isOnline,
      isAvailable: profile.isAvailable,
    });

    return {
      id: profile.id,
      isOnline: profile.isOnline,
      isAvailable: profile.isAvailable,
      activeDeliveries: active,
      lastSeenAt: profile.lastSeenAt?.toISOString() ?? null,
    };
  }

  /** Tableau de bord du livreur : sa journée en un coup d'œil. */
  async dashboard(user: AuthenticatedUser) {
    if (!user.driverProfileId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, 'Ce compte n’a pas de profil livreur.');
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [profile, active, todayCompleted, todayFees] = await Promise.all([
      this.prisma.driverProfile.findUniqueOrThrow({ where: { id: user.driverProfileId } }),
      this.prisma.delivery.count({
        where: { driverId: user.driverProfileId, status: { in: DELIVERY_ACTIVE } },
      }),
      this.prisma.delivery.count({
        where: {
          driverId: user.driverProfileId,
          status: DeliveryStatus.DELIVERED,
          deliveredAt: { gte: startOfDay },
        },
      }),
      this.prisma.order.aggregate({
        _sum: { deliveryFee: true },
        where: {
          delivery: { driverId: user.driverProfileId, status: DeliveryStatus.DELIVERED },
          deliveredAt: { gte: startOfDay },
        },
      }),
    ]);

    return {
      driverCode: profile.driverCode,
      isOnline: profile.isOnline,
      isAvailable: profile.isAvailable,
      activeDeliveries: active,
      completedToday: todayCompleted,
      earningsToday: todayFees._sum.deliveryFee ?? 0,
      rating: profile.rating,
      stats: await this.stats(profile.id),
    };
  }

  // ──────────────────────────────── Outils ────────────────────────────────

  private async uniqueDriverCode(tx: Prisma.TransactionClient, seed: number): Promise<string> {
    let sequence = seed;
    for (;;) {
      const candidate = generateDriverCode(sequence);
      const exists = await tx.driverProfile.findUnique({
        where: { driverCode: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
      sequence += 1;
    }
  }

  /** Forme attendue par le back-office React (`Driver`). */
  private toDto(driver: DriverRow) {
    return {
      id: driver.id,
      userId: driver.user.id,
      driverCode: driver.driverCode,
      firstName: driver.user.firstName,
      lastName: driver.user.lastName,
      fullName: `${driver.user.firstName} ${driver.user.lastName}`.trim(),
      phone: driver.user.phone,
      email: driver.user.email,
      avatarUrl: driver.user.avatarUrl,
      vehicleType: toWire(driver.vehicleType),
      plateNumber: driver.plateNumber,
      zone: driver.zone,
      status: toWire(driver.user.status),
      availability: driver.isOnline ? 'online' : 'offline',
      workState:
        driver.user.status === AccountStatus.SUSPENDED
          ? 'suspended'
          : driver.isAvailable
            ? 'available'
            : 'busy',
      rating: driver.rating,
      completedDeliveries: driver.completedDeliveries,
      activeDeliveries: driver._count?.deliveries ?? 0,
      lastSeenAt: driver.lastSeenAt?.toISOString() ?? null,
      createdAt: driver.user.createdAt.toISOString(),
    };
  }
}
