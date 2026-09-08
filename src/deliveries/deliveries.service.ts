import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryStatus,
  NotificationType,
  OrderStatus,
  OrderType,
  Prisma,
  Role,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { distanceMeters, estimatedMinutes, isValidCoordinates } from '../common/utils/geo.util';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SettingsService } from '../settings/settings.service';
import {
  DELIVERY_ACTIVE,
  assertDeliveryTransition,
  deliveryStatusLabel,
  timestampField,
} from './delivery-status';
import { DeliveryVerificationService } from './delivery-verification.service';
import { DriverAssignmentService } from './driver-assignment.service';
import {
  DELIVERY_INCLUDE,
  toDeliveryDto,
  toDriverDeliveryDto,
  type DeliveryWithRelations,
} from './delivery.mapper';
import type {
  CompleteDeliveryDto,
  DeliveryQueryDto,
  DriverDeliveryQueryDto,
  UpdateLocationDto,
} from './dto/delivery.dto';

/**
 * Livraisons.
 *
 * Le cycle de vie d'une course pilote celui de la commande : quand le
 * livreur récupère le repas, la commande passe « en livraison » ; quand
 * il confirme la remise avec le code du client, elle passe « livrée ».
 * Cette répercussion est faite ici, en un seul endroit, jamais par le
 * client mobile.
 */
@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly assignment: DriverAssignmentService,
    private readonly verification: DeliveryVerificationService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ───────────────────────────── Assignation ──────────────────────────────

  /**
   * Attribue (ou réattribue) une commande à un livreur.
   *
   * Toute la séquence est transactionnelle : deux gestionnaires qui
   * cliquent en même temps ne peuvent pas créer deux courses, et un
   * livreur ne peut pas être assigné à une commande déjà partie.
   */
  async assign(
    orderId: string,
    driverId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
    comment?: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { delivery: true, customer: { select: { id: true, firstName: true } } },
    });

    if (!order) throw AppException.notFound('Commande introuvable.');

    if (order.type !== OrderType.DELIVERY) {
      throw AppException.conflict(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        "Cette commande est à emporter : elle n'a pas de livraison.",
      );
    }

    const assignableStatuses: OrderStatus[] = [
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.ASSIGNED,
      OrderStatus.OUT_FOR_DELIVERY,
    ];

    if (!assignableStatuses.includes(order.status)) {
      throw AppException.conflict(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        `Une commande ${toWire(order.status)} ne peut pas être attribuée à un livreur.`,
      );
    }

    const existing = order.delivery;
    const isReassignment = Boolean(existing?.driverId);

    if (existing?.status === DeliveryStatus.DELIVERED) {
      throw AppException.conflict(
        ERROR_CODES.DELIVERY_ALREADY_ASSIGNED,
        'Cette livraison est déjà terminée.',
      );
    }

    if (existing?.driverId === driverId) {
      throw AppException.conflict(
        ERROR_CODES.DELIVERY_ALREADY_ASSIGNED,
        'Ce livreur est déjà en charge de cette commande.',
      );
    }

    const restaurant = await this.settings.getRestaurantCached();

    const { delivery, code, previousDriverId } = await this.prisma.transaction(async (tx) => {
      const driver = await this.assignment.assertAssignable(driverId, tx);

      const snapshot = order.addressSnapshot as Prisma.JsonObject | null;
      const target = isValidCoordinates({
        latitude: (snapshot?.latitude as number | null) ?? undefined,
        longitude: (snapshot?.longitude as number | null) ?? undefined,
      })
        ? { latitude: snapshot!.latitude as number, longitude: snapshot!.longitude as number }
        : null;

      const meters = target
        ? distanceMeters({ latitude: restaurant.latitude, longitude: restaurant.longitude }, target)
        : null;

      const estimatedArrivalAt = meters
        ? new Date(Date.now() + estimatedMinutes(meters) * 60_000)
        : new Date(Date.now() + restaurant.averageDeliveryMinutes * 60_000);

      const previous = existing?.driverId ?? null;

      const saved = existing
        ? await tx.delivery.update({
            where: { id: existing.id },
            data: {
              driverId,
              status: DeliveryStatus.ASSIGNED,
              assignedAt: new Date(),
              acceptedAt: null,
              assignedById: actor.id,
              distanceMeters: meters,
              estimatedArrivalAt,
              failureReason: null,
              failedAt: null,
              reassignmentCount: { increment: 1 },
            },
          })
        : await tx.delivery.create({
            data: {
              orderId,
              driverId,
              status: DeliveryStatus.ASSIGNED,
              assignedAt: new Date(),
              assignedById: actor.id,
              distanceMeters: meters,
              estimatedArrivalAt,
            },
          });

      await tx.deliveryEvent.create({
        data: {
          deliveryId: saved.id,
          status: DeliveryStatus.ASSIGNED,
          comment: comment ?? `Attribuée à ${driver.driverCode}`,
          actorId: actor.id,
        },
      });

      // Le livreur devient indisponible ; l'ancien est libéré s'il n'a
      // plus rien en cours.
      await tx.driverProfile.update({ where: { id: driverId }, data: { isAvailable: false } });
      if (previous && previous !== driverId) {
        await this.assignment.refreshAvailability(previous, tx);
      }

      // La commande ne bascule en ASSIGNED que si elle était prête :
      // une pré-attribution pendant la préparation ne change pas son statut.
      if (order.status === OrderStatus.READY) {
        await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.ASSIGNED } });
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            status: OrderStatus.ASSIGNED,
            comment: 'Livreur attribué',
            actorId: actor.id,
          },
        });
      }

      // Code de remise : généré à l'attribution, communiqué au client.
      const generated = await this.verification.issue(saved.id, tx);

      return { delivery: saved, code: generated, previousDriverId: previous };
    });

    const full = await this.findRaw(delivery.id);

    this.realtime.deliveryAssigned({
      id: delivery.id,
      orderId,
      driverProfileId: driverId,
      customerId: order.customerId,
      status: toWire(DeliveryStatus.ASSIGNED),
      orderReference: order.reference,
    });

    const driverUserId = full.driver?.userId;
    if (driverUserId) {
      await this.notifications.notify({
        userId: driverUserId,
        type: NotificationType.NEW_DELIVERY,
        title: 'Nouvelle course',
        body: `Commande ${order.reference} à livrer.`,
        entityId: delivery.id,
        link: `/deliveries/${delivery.id}`,
      });
    }

    // Le code n'existe en clair qu'ici : il part directement au client.
    if (order.customerId) {
      await this.notifications.notify({
        userId: order.customerId,
        type: NotificationType.DRIVER_ASSIGNED,
        title: 'Un livreur prend en charge votre commande',
        body: `Votre code de confirmation est ${code}. Communiquez-le au livreur à la remise.`,
        entityId: order.id,
        data: { deliveryId: delivery.id, code },
      });
    }

    await this.audit.record({
      actor,
      action: isReassignment ? 'DELIVERY_REASSIGN' : 'DELIVERY_ASSIGN',
      module: 'deliveries',
      entityType: 'Delivery',
      entityId: delivery.id,
      oldValue: { driverId: previousDriverId },
      newValue: { driverId, orderId },
      context,
    });

    return this.orders.findOne(actor, orderId);
  }

  // ─────────────────────────── Lecture back-office ────────────────────────

  async list(query: DeliveryQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.DeliveryWhereInput = {};

    const status = parseEnum(DeliveryStatus, query.status);
    if (status) where.status = status;
    if (query.driverId && query.driverId !== 'all') where.driverId = query.driverId;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.order = {
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { customer: { firstName: { contains: query.search, mode: 'insensitive' } } },
          { customer: { lastName: { contains: query.search, mode: 'insensitive' } } },
          { customer: { phone: { contains: query.search } } },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        include: DELIVERY_INCLUDE,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return paginate(rows.map(toDeliveryDto), total, query.page, query.limit);
  }

  /** Courses en cours — écran de supervision du back-office. */
  async active() {
    const rows = await this.prisma.delivery.findMany({
      where: { status: { in: DELIVERY_ACTIVE } },
      include: DELIVERY_INCLUDE,
      orderBy: { assignedAt: 'asc' },
      take: 100,
    });

    return rows.map(toDeliveryDto);
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const delivery = await this.findRaw(id);
    this.assertCanRead(user, delivery);
    return toDeliveryDto(delivery);
  }

  private async findRaw(id: string): Promise<DeliveryWithRelations & { driver?: { userId: string } | null }> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        ...DELIVERY_INCLUDE,
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!delivery) throw AppException.notFound('Livraison introuvable.');
    return delivery as DeliveryWithRelations & { driver?: { userId: string } | null };
  }

  private assertCanRead(user: AuthenticatedUser, delivery: DeliveryWithRelations): void {
    if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) return;
    if (user.role === Role.DRIVER && delivery.driverId === user.driverProfileId) return;
    if (user.role === Role.CUSTOMER && delivery.order?.customerId === user.id) return;

    throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à cette livraison.");
  }

  // ────────────────────────────── Côté livreur ────────────────────────────

  async listForDriver(
    driverProfileId: string,
    query: DriverDeliveryQueryDto,
  ): Promise<PaginatedResult<unknown>> {
    const where: Prisma.DeliveryWhereInput = {
      driverId: driverProfileId,
      ...(query.scope === 'active'
        ? { status: { in: DELIVERY_ACTIVE } }
        : query.scope === 'history'
          ? { status: { in: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED] } }
          : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        include: { ...DELIVERY_INCLUDE, events: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return paginate(
      rows.map((row) => toDriverDeliveryDto(row as DeliveryWithRelations)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOneForDriver(driverProfileId: string, id: string) {
    const delivery = await this.findRaw(id);

    if (delivery.driverId !== driverProfileId) {
      // Un livreur ne doit pas pouvoir sonder l'existence des courses des autres.
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Cette livraison ne vous est pas attribuée.",
      );
    }

    return toDriverDeliveryDto(delivery);
  }

  /**
   * Transition demandée par le livreur.
   * L'appartenance est vérifiée avant tout, puis la machine à états.
   */
  async advance(
    user: AuthenticatedUser,
    deliveryId: string,
    target: DeliveryStatus,
    context: RequestContext,
    options: { comment?: string; latitude?: number; longitude?: number } = {},
  ) {
    if (!user.driverProfileId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, 'Ce compte n’a pas de profil livreur.');
    }

    const delivery = await this.findRaw(deliveryId);

    if (delivery.driverId !== user.driverProfileId) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Cette livraison ne vous est pas attribuée.',
      );
    }

    assertDeliveryTransition(delivery.status, target);

    const updated = await this.applyTransition(delivery, target, user, context, options);
    return toDriverDeliveryDto(updated);
  }

  /**
   * Confirmation de remise.
   *
   * Le code du client est la seule preuve acceptée : sans lui, la course
   * ne peut pas être marquée livrée, même par le livreur assigné.
   */
  async complete(
    user: AuthenticatedUser,
    deliveryId: string,
    dto: CompleteDeliveryDto,
    context: RequestContext,
  ) {
    if (!user.driverProfileId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, 'Ce compte n’a pas de profil livreur.');
    }

    const delivery = await this.findRaw(deliveryId);

    if (delivery.driverId !== user.driverProfileId) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Cette livraison ne vous est pas attribuée.',
      );
    }

    if (delivery.status === DeliveryStatus.DELIVERED) {
      throw AppException.conflict(
        ERROR_CODES.INVALID_DELIVERY_TRANSITION,
        'Cette livraison est déjà confirmée.',
      );
    }

    // Le code est vérifié AVANT toute écriture : une tentative ratée ne
    // doit rien changer à l'état de la course.
    await this.verification.verify(deliveryId, dto.code);

    if (delivery.status !== DeliveryStatus.ARRIVED_AT_CUSTOMER) {
      // Le livreur a saisi le code sans déclarer son arrivée : on
      // l'enregistre plutôt que de lui refuser la remise.
      assertDeliveryTransition(delivery.status, DeliveryStatus.ARRIVED_AT_CUSTOMER);
      await this.applyTransition(delivery, DeliveryStatus.ARRIVED_AT_CUSTOMER, user, context, {
        comment: 'Arrivée déclarée à la saisie du code',
        latitude: dto.latitude,
        longitude: dto.longitude,
      });
    }

    const fresh = await this.findRaw(deliveryId);
    const updated = await this.applyTransition(fresh, DeliveryStatus.DELIVERED, user, context, {
      comment: 'Remise confirmée par code',
      latitude: dto.latitude,
      longitude: dto.longitude,
    });

    await this.audit.record({
      actor: user,
      action: 'DELIVERY_COMPLETED',
      module: 'deliveries',
      entityType: 'Delivery',
      entityId: deliveryId,
      newValue: { orderId: delivery.orderId, status: DeliveryStatus.DELIVERED },
      context,
    });

    return toDriverDeliveryDto(updated);
  }

  /**
   * Refus d'une course.
   * La commande retourne dans la file d'attribution, et le back-office
   * est prévenu : personne ne doit découvrir le refus en consultant un tableau.
   */
  async decline(
    user: AuthenticatedUser,
    deliveryId: string,
    reason: string,
    context: RequestContext,
  ) {
    if (!user.driverProfileId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, 'Ce compte n’a pas de profil livreur.');
    }

    const delivery = await this.findRaw(deliveryId);

    if (delivery.driverId !== user.driverProfileId) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Cette livraison ne vous est pas attribuée.',
      );
    }

    if (delivery.status !== DeliveryStatus.ASSIGNED) {
      throw AppException.conflict(
        ERROR_CODES.INVALID_DELIVERY_TRANSITION,
        `Une course ${deliveryStatusLabel(delivery.status)} ne peut plus être refusée. Contactez le restaurant.`,
      );
    }

    const driverProfileId = user.driverProfileId;

    await this.prisma.transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: deliveryId },
        data: { driverId: null, assignedAt: null, acceptedAt: null },
      });

      await tx.deliveryEvent.create({
        data: {
          deliveryId,
          status: DeliveryStatus.ASSIGNED,
          comment: `Refusée : ${reason}`,
          actorId: user.id,
        },
      });

      await this.assignment.refreshAvailability(driverProfileId, tx);

      // La commande redevient « prête » : elle attend un autre livreur.
      const order = await tx.order.findUnique({ where: { id: delivery.orderId } });
      if (order?.status === OrderStatus.ASSIGNED) {
        await tx.order.update({
          where: { id: delivery.orderId },
          data: { status: OrderStatus.READY },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: delivery.orderId,
            status: OrderStatus.READY,
            comment: 'Course refusée par le livreur',
            actorId: user.id,
          },
        });
      }
    });

    await this.notifications.notifyBackOffice({
      type: NotificationType.ADMIN_ALERT,
      title: 'Course refusée',
      body: `${user.firstName} ${user.lastName} a refusé la commande ${delivery.order?.reference ?? ''} : ${reason}`,
      entityId: delivery.orderId,
      link: `/orders/${delivery.orderId}`,
    });

    await this.audit.record({
      actor: user,
      action: 'DELIVERY_DECLINED',
      module: 'deliveries',
      entityType: 'Delivery',
      entityId: deliveryId,
      newValue: { reason },
      context,
    });

    return { success: true };
  }

  /** Échec constaté sur le terrain (client injoignable, adresse fausse). */
  async fail(
    user: AuthenticatedUser,
    deliveryId: string,
    reason: string,
    context: RequestContext,
  ) {
    const delivery = await this.findRaw(deliveryId);

    const isOwner = user.role === Role.DRIVER && delivery.driverId === user.driverProfileId;
    const isBackOffice = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;

    if (!isOwner && !isBackOffice) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Cette livraison ne vous est pas attribuée.',
      );
    }

    assertDeliveryTransition(delivery.status, DeliveryStatus.FAILED);

    const updated = await this.applyTransition(delivery, DeliveryStatus.FAILED, user, context, {
      comment: reason,
    });

    await this.notifications.notifyBackOffice({
      type: NotificationType.ADMIN_ALERT,
      title: 'Livraison en échec',
      body: `Commande ${delivery.order?.reference ?? ''} : ${reason}`,
      entityId: delivery.orderId,
      link: `/orders/${delivery.orderId}`,
    });

    await this.audit.record({
      actor: user,
      action: 'DELIVERY_FAILED',
      module: 'deliveries',
      entityType: 'Delivery',
      entityId: deliveryId,
      newValue: { reason },
      context,
    });

    return toDeliveryDto(updated);
  }

  /** Correction de statut par le back-office (permission DELIVERIES_UPDATE). */
  async updateStatusByStaff(
    user: AuthenticatedUser,
    deliveryId: string,
    status: string,
    context: RequestContext,
    comment?: string,
  ) {
    const target = parseEnum(DeliveryStatus, status) as DeliveryStatus | undefined;
    if (!target) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_ERROR, 'Statut de livraison inconnu.');
    }

    const delivery = await this.findRaw(deliveryId);
    assertDeliveryTransition(delivery.status, target);

    const updated = await this.applyTransition(delivery, target, user, context, { comment });

    await this.audit.record({
      actor: user,
      action: 'DELIVERY_STATUS_UPDATE',
      module: 'deliveries',
      entityType: 'Delivery',
      entityId: deliveryId,
      oldValue: { status: delivery.status },
      newValue: { status: target, comment: comment ?? null },
      context,
    });

    return toDeliveryDto(updated);
  }

  /**
   * Cœur des transitions : écrit la course, son historique, répercute sur
   * la commande, met à jour la disponibilité du livreur et diffuse.
   */
  private async applyTransition(
    delivery: DeliveryWithRelations,
    target: DeliveryStatus,
    actor: AuthenticatedUser,
    context: RequestContext,
    options: { comment?: string; latitude?: number; longitude?: number } = {},
  ): Promise<DeliveryWithRelations> {
    const field = timestampField(target);
    const now = new Date();

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.delivery.update({
        where: { id: delivery.id },
        data: {
          status: target,
          ...(field ? { [field]: now } : {}),
          ...(target === DeliveryStatus.FAILED ? { failureReason: options.comment ?? null } : {}),
        },
        include: { ...DELIVERY_INCLUDE, events: { orderBy: { createdAt: 'asc' } } },
      });

      await tx.deliveryEvent.create({
        data: {
          deliveryId: delivery.id,
          status: target,
          comment: options.comment,
          actorId: actor.id,
          latitude: options.latitude,
          longitude: options.longitude,
        },
      });

      if (delivery.driverId) {
        if (target === DeliveryStatus.DELIVERED) {
          const minutes = delivery.assignedAt
            ? Math.max(1, Math.round((now.getTime() - delivery.assignedAt.getTime()) / 60_000))
            : 0;

          await tx.driverProfile.update({
            where: { id: delivery.driverId },
            data: {
              completedDeliveries: { increment: 1 },
              totalDistanceMeters: { increment: delivery.distanceMeters ?? 0 },
              totalDeliveryMinutes: { increment: minutes },
            },
          });
        }

        if (target === DeliveryStatus.FAILED) {
          await tx.driverProfile.update({
            where: { id: delivery.driverId },
            data: { cancelledDeliveries: { increment: 1 } },
          });
        }

        await this.assignment.refreshAvailability(delivery.driverId, tx);
      }

      return result;
    });

    // Répercussion sur la commande, hors transaction de livraison : le
    // service de commandes gère sa propre machine à états et ses effets.
    if (target === DeliveryStatus.PICKED_UP) {
      await this.orders
        .applySystemTransition(
          delivery.orderId,
          OrderStatus.OUT_FOR_DELIVERY,
          actor,
          context,
          'Commande récupérée par le livreur',
        )
        .catch((error: Error) =>
          this.logger.warn(`Commande ${delivery.orderId} non basculée : ${error.message}`),
        );
    }

    if (target === DeliveryStatus.DELIVERED) {
      await this.orders.applySystemTransition(
        delivery.orderId,
        OrderStatus.DELIVERED,
        actor,
        context,
        'Remise confirmée par code',
      );
    }

    const customerId = delivery.order?.customerId;

    this.realtime.deliveryStatusUpdated({
      id: delivery.id,
      orderId: delivery.orderId,
      status: toWire(target),
      customerId: customerId ?? null,
      driverProfileId: delivery.driverId,
    });

    if (customerId) {
      const messages: Partial<Record<DeliveryStatus, { type: NotificationType; title: string; body: string }>> = {
        [DeliveryStatus.PICKED_UP]: {
          type: NotificationType.DELIVERY_STARTED,
          title: 'Votre commande est en route',
          body: `Le livreur a récupéré votre commande ${delivery.order?.reference ?? ''}.`,
        },
        [DeliveryStatus.ARRIVED_AT_CUSTOMER]: {
          type: NotificationType.DELIVERY_ARRIVED,
          title: 'Le livreur est arrivé',
          body: 'Munissez-vous de votre code de confirmation.',
        },
        [DeliveryStatus.FAILED]: {
          type: NotificationType.ADMIN_ALERT,
          title: 'Livraison interrompue',
          body: options.comment ?? 'Le restaurant va vous contacter.',
        },
      };

      const message = messages[target];
      if (message) {
        await this.notifications.notify({
          userId: customerId,
          type: message.type,
          title: message.title,
          body: message.body,
          entityId: delivery.orderId,
        });
      }
    }

    return updated as DeliveryWithRelations;
  }

  // ──────────────────────────── Géolocalisation ───────────────────────────

  /**
   * Position transmise par le livreur.
   *
   * Deux écritures : l'historique (pour rejouer un trajet, arbitrer un
   * litige) et la dernière position sur le profil (lecture immédiate,
   * sans agrégat). La diffusion temps réel n'atteint que le salon de la
   * commande concernée : un client ne suit jamais un livreur qui ne livre
   * pas sa commande.
   */
  async updateLocation(user: AuthenticatedUser, dto: UpdateLocationDto) {
    if (!user.driverProfileId) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, 'Ce compte n’a pas de profil livreur.');
    }

    const driverProfileId = user.driverProfileId;
    let deliveryId = dto.deliveryId ?? null;

    if (deliveryId) {
      const delivery = await this.prisma.delivery.findUnique({
        where: { id: deliveryId },
        select: { driverId: true, orderId: true, status: true },
      });

      if (!delivery || delivery.driverId !== driverProfileId) {
        throw AppException.forbidden(
          ERROR_CODES.FORBIDDEN,
          'Cette livraison ne vous est pas attribuée.',
        );
      }
    } else {
      // Sans précision, on rattache la position à la course en cours.
      const current = await this.prisma.delivery.findFirst({
        where: { driverId: driverProfileId, status: { in: DELIVERY_ACTIVE } },
        orderBy: { assignedAt: 'desc' },
        select: { id: true },
      });
      deliveryId = current?.id ?? null;
    }

    const recordedAt = new Date();

    await this.prisma.$transaction([
      this.prisma.driverLocation.create({
        data: {
          driverId: driverProfileId,
          deliveryId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracy: dto.accuracy,
          heading: dto.heading,
          speed: dto.speed,
          recordedAt,
        },
      }),
      this.prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: {
          lastLatitude: dto.latitude,
          lastLongitude: dto.longitude,
          lastPositionAt: recordedAt,
          lastSeenAt: recordedAt,
        },
      }),
    ]);

    const orderId = deliveryId
      ? ((
          await this.prisma.delivery.findUnique({
            where: { id: deliveryId },
            select: { orderId: true },
          })
        )?.orderId ?? null)
      : null;

    this.realtime.driverLocationUpdated({
      driverProfileId,
      orderId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      heading: dto.heading ?? null,
      speed: dto.speed ?? null,
      recordedAt: recordedAt.toISOString(),
    });

    return { success: true, recordedAt: recordedAt.toISOString() };
  }

  /**
   * Position du livreur pour une commande donnée.
   *
   * Le client n'y accède que pour SA commande, et seulement tant qu'elle
   * est en cours : une fois livrée, la position du livreur ne le regarde plus.
   */
  async locationForOrder(user: AuthenticatedUser, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { delivery: { include: { driver: true } } },
    });

    if (!order) throw AppException.notFound('Commande introuvable.');

    const isCustomer = user.role === Role.CUSTOMER && order.customerId === user.id;
    const isBackOffice = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;
    const isAssignedDriver =
      user.role === Role.DRIVER && order.delivery?.driverId === user.driverProfileId;

    if (!isCustomer && !isBackOffice && !isAssignedDriver) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à ce suivi.");
    }

    const delivery = order.delivery;
    if (!delivery?.driver) return null;

    const finished =
      delivery.status === DeliveryStatus.DELIVERED || delivery.status === DeliveryStatus.FAILED;

    if (finished && !isBackOffice) return null;

    if (delivery.driver.lastLatitude === null || delivery.driver.lastLongitude === null) {
      return null;
    }

    return {
      deliveryId: delivery.id,
      status: toWire(delivery.status),
      latitude: delivery.driver.lastLatitude,
      longitude: delivery.driver.lastLongitude,
      updatedAt: delivery.driver.lastPositionAt?.toISOString() ?? null,
      estimatedArrivalAt: delivery.estimatedArrivalAt?.toISOString() ?? null,
    };
  }

  /** Trace complète d'une course — supervision et litiges. */
  async trail(user: AuthenticatedUser, deliveryId: string) {
    const delivery = await this.findRaw(deliveryId);
    this.assertCanRead(user, delivery);

    const points = await this.prisma.driverLocation.findMany({
      where: { deliveryId },
      orderBy: { recordedAt: 'asc' },
      take: 500,
      select: { latitude: true, longitude: true, recordedAt: true, speed: true },
    });

    return points.map((point) => ({
      latitude: point.latitude,
      longitude: point.longitude,
      speed: point.speed,
      at: point.recordedAt.toISOString(),
    }));
  }

  /** Code de confirmation côté client (statut, jamais le code lui-même). */
  async verificationStatus(user: AuthenticatedUser, deliveryId: string) {
    const delivery = await this.findRaw(deliveryId);
    this.assertCanRead(user, delivery);
    return this.verification.statusFor(deliveryId);
  }

  /** Régénère un code — utile si le client n'a pas reçu la notification. */
  async regenerateCode(user: AuthenticatedUser, deliveryId: string, context: RequestContext) {
    const delivery = await this.findRaw(deliveryId);

    const isCustomer = user.role === Role.CUSTOMER && delivery.order?.customerId === user.id;
    const isBackOffice = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;

    if (!isCustomer && !isBackOffice) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à cette livraison.");
    }

    if (delivery.status === DeliveryStatus.DELIVERED) {
      throw AppException.conflict(
        ERROR_CODES.INVALID_DELIVERY_TRANSITION,
        'Cette livraison est déjà terminée.',
      );
    }

    const code = await this.verification.issue(deliveryId);
    const customerId = delivery.order?.customerId;

    if (customerId) {
      await this.notifications.notify({
        userId: customerId,
        type: NotificationType.DRIVER_ASSIGNED,
        title: 'Nouveau code de confirmation',
        body: `Votre code est ${code}.`,
        entityId: delivery.orderId,
        data: { deliveryId, code },
      });
    }

    await this.audit.record({
      actor: user,
      action: 'DELIVERY_CODE_REGENERATED',
      module: 'deliveries',
      entityType: 'Delivery',
      entityId: deliveryId,
      context,
    });

    return { success: true };
  }
}
