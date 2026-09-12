import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeliveryStatus,
  NotificationType,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { IdempotencyService } from '../common/services/idempotency.service';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { formatAmount } from '../common/utils/money.util';
import { generateOrderReference, generateTransactionRef } from '../common/utils/reference.util';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { RestaurantRouter } from '../common/context/restaurant-router.service';
import { isValidCoordinates } from '../common/utils/geo.util';
import { PrismaService } from '../database/prisma.service';
import { RecipesService } from '../finance/recipes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SettingsService } from '../settings/settings.service';
import type {
  CancelOrderDto,
  CreateOrderDto,
  CustomerOrderQueryDto,
  OrderQueryDto,
  QuoteOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import {
  ORDER_DETAIL_INCLUDE,
  ORDER_SUMMARY_INCLUDE,
  toOrderDetail,
  toOrderSummary,
  toOrderTracking,
} from './order.mapper';
import {
  CUSTOMER_CANCELLABLE,
  TRANSITION_PERMISSION,
  assertNotDriverOwned,
  assertTransition,
  statusLabel,
} from './order-status';
import { PricingService, type LineInput } from './pricing.service';

/**
 * Service central des commandes.
 *
 * Un seul service pour les quatre rôles (règle §86 du contrat) : il n'y a
 * ni `CustomerOrderService` ni `AdminOrderService`. Ce qui change d'un
 * rôle à l'autre, c'est le filtre appliqué et les transitions autorisées —
 * pas la logique métier, qui doit rester unique pour rester juste.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly recipes: RecipesService,
    private readonly config: ConfigService,
    private readonly router: RestaurantRouter,
  ) {}

  // ─────────────────────────────── Devis ──────────────────────────────────

  /**
   * Aperçu du prix avant validation.
   * L'écran de paiement affiche exactement ce que le serveur facturera.
   */
  async quote(userId: string, dto: QuoteOrderDto, cartLines?: LineInput[]) {
    const lines = dto.items?.length
      ? dto.items.map<LineInput>((item) => ({
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          optionIds: item.optionIds ?? [],
          note: item.note,
        }))
      : (cartLines ?? []);

    const quote = await this.pricing.quote({
      lines,
      orderType: (parseEnum(OrderType, dto.type) ?? OrderType.DELIVERY) as OrderType,
      promotionCode: dto.promotionCode ?? null,
      customerId: userId,
    });

    return {
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      discount: quote.discount,
      total: quote.total,
      currency: quote.currency,
      promotion: quote.promotion,
      minimumOrder: quote.minimumOrder,
      meetsMinimum: quote.subtotal >= quote.minimumOrder,
      estimatedPreparationMinutes: quote.estimatedPreparationMinutes,
      lines: quote.lines,
    };
  }

  // ────────────────────────────── Création ────────────────────────────────

  async create(
    user: AuthenticatedUser,
    dto: CreateOrderDto,
    context: RequestContext,
    options: {
      idempotencyKey?: string;
      fromCart: boolean;
      /**
       * Lecture différée du panier.
       *
       * Le panier est lu APRÈS le contrôle d'idempotence : sinon, un client
       * qui rejoue sa requête (réponse perdue en chemin) verrait « panier
       * vide » — le panier ayant été consommé par la première tentative —
       * au lieu de recevoir la réponse mémorisée.
       */
      loadCartLines?: () => Promise<LineInput[]>;
    },
  ) {
    return this.idempotency.execute(
      {
        userId: user.id,
        endpoint: 'POST /orders',
        key: options.idempotencyKey,
        payload: dto,
      },
      () => this.createOrder(user, dto, context, options),
    );
  }

  private async createOrder(
    user: AuthenticatedUser,
    dto: CreateOrderDto,
    context: RequestContext,
    options: { fromCart: boolean; loadCartLines?: () => Promise<LineInput[]> },
  ) {
    const orderType = (parseEnum(OrderType, dto.type) ?? OrderType.DELIVERY) as OrderType;

    const lines = dto.items?.length
      ? dto.items.map<LineInput>((item) => ({
          menuItemId: item.menuItemId,
          quantity: item.quantity,
          optionIds: item.optionIds ?? [],
          note: item.note,
        }))
      : ((await options.loadCartLines?.()) ?? []);

    if (lines.length === 0) {
      throw AppException.badRequest(ERROR_CODES.CART_EMPTY, 'Votre panier est vide.');
    }

    /*
     * **Quelle cuisine prépare cette commande.**
     *
     * Celle dont viennent les plats, et aucune autre : un plat appartient
     * à une carte, une carte à un établissement. Le client a vu ces
     * prix-là, sur cette carte-là ; c'est cette maison qui doit cuisiner,
     * encaisser et livrer.
     *
     * Jusqu'ici, toute commande était rattachée au **plus ancien**
     * établissement, quelle que soit la position du client, et l'alerte
     * partait à tous les gérants de l'enseigne : deux cuisines pouvaient
     * préparer le même plat, et deux livreurs partir pour la même porte.
     *
     * Un panier qui mélange deux maisons est refusé plutôt que réparti :
     * cela n'arrive que si la carte a changé sous les pieds du client —
     * il a déménagé, ou enregistré une adresse plus proche d'une autre
     * maison — et il faut alors qu'il le sache, pas qu'on choisisse à sa
     * place laquelle des deux servira.
     */
    const maisons = await this.router.forMenuItems(
      lines.map((line) => line.menuItemId),
    );

    if (maisons.length > 1) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Votre panier contient des plats de deux établissements différents. ' +
          'Videz-le et recommencez pour commander dans un seul.',
      );
    }

    const restaurant = await this.settings.assertOpenForOrders(maisons[0] ?? null);

    if (orderType === OrderType.DELIVERY && !restaurant.deliveryEnabled) {
      throw AppException.conflict(
        ERROR_CODES.DELIVERY_DISABLED,
        'La livraison est momentanément suspendue. Choisissez le retrait sur place.',
      );
    }

    if (orderType === OrderType.PICKUP && !restaurant.pickupEnabled) {
      throw AppException.conflict(
        ERROR_CODES.PICKUP_DISABLED,
        'Le retrait sur place est momentanément suspendu.',
      );
    }

    // Adresse : vérifiée comme appartenant au client, puis figée dans la
    // commande. Une modification ultérieure du carnet ne la changera pas.
    let address = null as Awaited<ReturnType<PrismaService['address']['findFirst']>> | null;
    if (orderType === OrderType.DELIVERY) {
      if (!dto.addressId) {
        throw AppException.badRequest(
          ERROR_CODES.ADDRESS_REQUIRED,
          'Choisissez une adresse de livraison.',
        );
      }
      address = await this.prisma.address.findFirst({
        where: { id: dto.addressId, userId: user.id, deletedAt: null },
      });
      if (!address) {
        throw AppException.badRequest(
          ERROR_CODES.ADDRESS_REQUIRED,
          'Adresse de livraison introuvable.',
        );
      }

      /*
       * **La maison la plus proche de l'adresse livrée est la seule à
       * pouvoir la servir.** C'est la règle de l'enseigne.
       *
       * Le panier désigne sa cuisine ; l'adresse, elle, désigne la
       * maison qui devrait livrer. Quand les deux divergent — un client
       * dont la carte est celle de Kaloum se fait livrer à deux pas de
       * Kipé — on n'envoie pas un livreur traverser la ville : on le
       * dit, avec les noms, et on laisse le client choisir entre changer
       * d'adresse et refaire son panier chez l'autre maison.
       *
       * Une adresse sans coordonnées ne peut pas trancher : elle est
       * livrée par la cuisine du panier. Les nouvelles adresses en ont
       * toutes ; les anciennes finiront par être corrigées.
       */
      if (isValidCoordinates({ latitude: address.latitude ?? undefined, longitude: address.longitude ?? undefined })) {
        const plusProche = await this.router.nearestTo({
          latitude: address.latitude as number,
          longitude: address.longitude as number,
        });

        if (plusProche && plusProche !== restaurant.id) {
          const autre = await this.settings.byId(plusProche);
          throw AppException.conflict(
            ERROR_CODES.CONFLICT,
            `Cette adresse est servie par « ${autre.name} », et votre panier vient de ` +
              `« ${restaurant.name} ». Choisissez une adresse plus proche de ` +
              `« ${restaurant.name} », ou videz le panier pour commander chez « ${autre.name} ».`,
          );
        }
      }
    }

    const paymentMethod = (parseEnum(PaymentMethod, dto.paymentMethod) ??
      PaymentMethod.CASH_ON_DELIVERY) as PaymentMethod;

    await this.assertPaymentMethodEnabled(paymentMethod);

    const created = await this.prisma.transaction(async (tx) => {
      // Le devis est recalculé DANS la transaction : entre l'aperçu et la
      // validation, un plat a pu passer en rupture ou changer de prix.
      const quote = await this.pricing.quote(
        {
          lines,
          orderType,
          promotionCode: dto.promotionCode ?? null,
          customerId: user.id,
        },
        tx,
      );

      if (quote.subtotal < restaurant.minimumOrderAmount) {
        throw AppException.badRequest(
          ERROR_CODES.MINIMUM_ORDER_NOT_REACHED,
          `Le minimum de commande est de ${formatAmount(restaurant.minimumOrderAmount)}.`,
          { minimumOrder: restaurant.minimumOrderAmount, subtotal: quote.subtotal },
        );
      }

      const now = new Date();
      const estimatedReadyAt = new Date(
        now.getTime() + quote.estimatedPreparationMinutes * 60_000,
      );
      const estimatedDeliveryAt =
        orderType === OrderType.DELIVERY
          ? new Date(estimatedReadyAt.getTime() + restaurant.averageDeliveryMinutes * 60_000)
          : null;

      const order = await tx.order.create({
        data: {
          reference: generateOrderReference(
            this.config.get<string>('orders.referencePrefix') ?? 'BRC',
            now,
          ),
          customerId: user.id,
          restaurantId: restaurant.id,
          addressId: address?.id ?? null,
          addressSnapshot: address
            ? ({
                id: address.id,
                label: address.label,
                street: address.street,
                district: address.district,
                city: address.city,
                latitude: address.latitude,
                longitude: address.longitude,
                phone: address.phone,
                instructions: address.instructions,
              } as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          type: orderType,
          status: OrderStatus.PENDING,
          subtotal: quote.subtotal,
          deliveryFee: quote.deliveryFee,
          discount: quote.discount,
          total: quote.total,
          paymentMethod,
          paymentStatus: PaymentStatus.PENDING,
          promotionId: quote.promotion?.id ?? null,
          promotionCode: quote.promotion?.code ?? null,
          note: dto.note,
          estimatedReadyAt,
          estimatedDeliveryAt,
          items: {
            create: quote.lines.map((line) => ({
              menuItemId: line.menuItemId,
              name: line.name,
              imageUrl: line.imageUrl,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              note: line.note,
              lineTotal: line.lineTotal,
              options: {
                create: line.options.map((option) => ({
                  optionId: option.optionId,
                  groupName: option.groupName,
                  optionName: option.optionName,
                  extraPrice: option.extraPrice,
                })),
              },
            })),
          },
          history: {
            create: {
              status: OrderStatus.PENDING,
              comment: 'Commande reçue',
              actorId: user.id,
            },
          },
          payment: {
            create: {
              transactionRef: generateTransactionRef(now),
              customerId: user.id,
              method: paymentMethod,
              status: PaymentStatus.PENDING,
              amount: quote.total,
              events: { create: { label: 'Paiement initialisé', status: PaymentStatus.PENDING } },
            },
          },
        },
        include: ORDER_DETAIL_INCLUDE,
      });

      // Compteurs : ils alimentent le tri par popularité et le tableau de
      // bord, sans avoir à agréger des millions de lignes à chaque affichage.
      for (const line of quote.lines) {
        await tx.menuItem.update({
          where: { id: line.menuItemId },
          data: { ordersCount: { increment: line.quantity } },
        });
      }

      await tx.customerProfile.upsert({
        where: { userId: user.id },
        update: { ordersCount: { increment: 1 }, lastOrderAt: now },
        create: { userId: user.id, ordersCount: 1, lastOrderAt: now },
      });

      if (quote.promotion) {
        await tx.promotion.update({
          where: { id: quote.promotion.id },
          data: { usageCount: { increment: 1 } },
        });
        await tx.couponUsage.create({
          data: {
            promotionId: quote.promotion.id,
            userId: user.id,
            orderId: order.id,
            discountAmount: quote.discount,
          },
        });
      }

      if (options.fromCart) {
        const cart = await tx.cart.findUnique({ where: { userId: user.id } });
        if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      }

      return order;
    });

    const summary = toOrderSummary(created);

    /*
     * La cuisine n'apprend l'existence d'une commande réglée en ligne
     * qu'une fois l'encaissement confirmé.
     *
     * L'annoncer dès la création reviendrait à faire engager des denrées
     * sur une commande qui peut n'être jamais payée : le client ouvre la
     * page de l'opérateur, se ravise, ferme son navigateur — et le
     * restaurant a déjà commencé. C'est `PaymentsService.confirm` qui
     * lance l'annonce, au moment où l'argent est là.
     *
     * Le paiement à la livraison, lui, n'attend rien : il n'y a pas
     * d'encaissement préalable à espérer, et retenir la commande
     * empêcherait simplement de la préparer.
     */
    const attendPaiement = created.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY;

    if (!attendPaiement) {
      // Hors transaction : une notification lente ne doit pas tenir un verrou.
      this.realtime.orderCreated({
        ...summary,
        customerId: created.customerId,
        restaurantId: created.restaurantId,
      });

      await this.notifications.notifyBackOffice(
        {
          type: NotificationType.ORDER_CREATED,
          title: 'Nouvelle commande',
          body: `${summary.customerName} — ${formatAmount(created.total)} (${created.reference})`,
          link: `/orders/${created.id}`,
          entityId: created.id,
        },
        // La cuisine qui prépare, et le propriétaire. Pas les autres
        // adresses : elles n'ont rien à faire de cette commande.
        created.restaurantId,
      );
    }

    await this.notifications.notify({
      userId: user.id,
      type: NotificationType.ORDER_CREATED,
      title: attendPaiement ? 'Commande en attente de paiement' : 'Commande enregistrée',
      body: attendPaiement
        ? `Votre commande ${created.reference} sera transmise à la cuisine dès le paiement.`
        : `Votre commande ${created.reference} a bien été reçue.`,
      entityId: created.id,
    });

    await this.audit.record({
      actor: user,
      action: 'ORDER_CREATE',
      module: 'orders',
      entityType: 'Order',
      entityId: created.id,
      newValue: {
        reference: created.reference,
        total: created.total,
        type: created.type,
        paymentMethod: created.paymentMethod,
      },
      context,
    });

    return toOrderDetail(created);
  }

  // ─────────────────────────────── Lecture ────────────────────────────────

  /** Liste destinée au back-office : filtres complets, aucune restriction. */
  async listForBackOffice(query: OrderQueryDto): Promise<PaginatedResult<unknown>> {
    const where = this.buildBackOfficeWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_SUMMARY_INCLUDE,
        orderBy: this.buildOrder(query),
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(
      rows.map((row) =>
        toOrderSummary({
          ...row,
          _count: { items: row.items.reduce((sum, item) => sum + item.quantity, 0) },
        }),
      ),
      total,
      query.page,
      query.limit,
    );
  }

  /** Liste d'un client : la clause `customerId` n'est pas négociable. */
  async listForCustomer(
    customerId: string,
    query: CustomerOrderQueryDto,
  ): Promise<PaginatedResult<unknown>> {
    const active: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.ASSIGNED,
      OrderStatus.OUT_FOR_DELIVERY,
    ];

    const where: Prisma.OrderWhereInput = {
      customerId,
      deletedAt: null,
      ...(query.scope === 'active'
        ? { status: { in: active } }
        : query.scope === 'past'
          ? { status: { in: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } }
          : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_SUMMARY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(
      rows.map((row) =>
        toOrderSummary({
          ...row,
          _count: { items: row.items.reduce((sum, item) => sum + item.quantity, 0) },
        }),
      ),
      total,
      query.page,
      query.limit,
    );
  }

  /**
   * Détail d'une commande, avec contrôle d'appartenance.
   *
   * Un CUSTOMER ne lit que ses commandes ; un DRIVER, uniquement celles
   * qui lui sont assignées ; le back-office, toutes.
   */
  async findOne(user: AuthenticatedUser, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: ORDER_DETAIL_INCLUDE,
    });

    if (!order) throw AppException.notFound('Commande introuvable.');
    this.assertCanRead(user, order.customerId, order.delivery?.driverId ?? null);

    return toOrderDetail(order);
  }

  /** Suivi temps réel, tel que l'affiche l'application mobile. */
  async tracking(user: AuthenticatedUser, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: ORDER_DETAIL_INCLUDE,
    });

    if (!order) throw AppException.notFound('Commande introuvable.');
    this.assertCanRead(user, order.customerId, order.delivery?.driverId ?? null);

    return toOrderTracking(order);
  }

  private assertCanRead(
    user: AuthenticatedUser,
    customerId: string | null,
    driverProfileId: string | null,
  ): void {
    if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) return;
    // `customerId` nul = vente au comptoir : elle n'appartient à personne,
    // donc à aucun client. Seul le back-office la lit.
    if (user.role === Role.CUSTOMER && customerId !== null && user.id === customerId) return;
    if (user.role === Role.DRIVER && driverProfileId && driverProfileId === user.driverProfileId) {
      return;
    }

    // Message volontairement identique à « introuvable » : on ne confirme
    // pas l'existence d'une commande à quelqu'un qui n'y a pas droit.
    throw AppException.forbidden(
      ERROR_CODES.FORBIDDEN,
      "Vous n'avez pas accès à cette commande.",
    );
  }

  // ─────────────────────────────── Transitions ────────────────────────────

  /**
   * Changement de statut demandé par le back-office.
   *
   * La transition est validée par la machine à états, la permission est
   * vérifiée par transition (avancer ≠ annuler), et chaque étape laisse
   * une trace dans l'historique.
   */
  async updateStatus(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateOrderStatusDto,
    context: RequestContext,
  ) {
    const target = parseEnum(OrderStatus, dto.status) as OrderStatus | undefined;
    if (!target) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_ERROR, 'Statut inconnu.');
    }

    if (target === OrderStatus.CANCELLED) {
      return this.cancel(user, id, { reason: dto.comment ?? 'Annulée par le restaurant' }, context);
    }

    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: { delivery: true },
    });
    if (!order) throw AppException.notFound('Commande introuvable.');

    assertTransition(order.status, target, order.type);
    // Une fois la course confiée, la suite se joue sur le terrain.
    assertNotDriverOwned(target, order.delivery);
    this.assertTransitionPermission(user, target);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: {
          status: target,
          // L'encaissement du paiement à la livraison est traité par
          // `settleOnDelivery`, commun aux deux chemins.
          ...(target === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
        },
        include: ORDER_DETAIL_INCLUDE,
      });

      await tx.orderStatusHistory.create({
        data: { orderId: id, status: target, comment: dto.comment, actorId: user.id },
      });

      if (target === OrderStatus.DELIVERED) {
        await this.settleOnDelivery(tx, result.id, result.customerId, result.total, order.paymentMethod);
      }

      await this.closeDeliveryWith(tx, id, target, dto.comment);

      return result;
    });

    await this.afterStatusChange(updated, target, user, context, dto.comment);
    return toOrderDetail(updated);
  }

  private assertTransitionPermission(user: AuthenticatedUser, target: OrderStatus): void {
    if (user.role === Role.SUPER_ADMIN) return;

    const required = TRANSITION_PERMISSION[target];
    if (!required) return;

    if (!user.permissions.includes(required)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Vous n'avez pas les permissions nécessaires pour cette opération.",
        { required: [required] },
      );
    }
  }

  /**
   * Annulation.
   *
   * Le client ne peut annuler que tant que la cuisine n'a pas commencé,
   * et seulement dans la fenêtre configurée. Passé ce délai, il doit
   * appeler le restaurant : des ingrédients ont déjà été engagés.
   */
  async cancel(
    user: AuthenticatedUser,
    id: string,
    dto: CancelOrderDto,
    context: RequestContext,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: { delivery: true, payment: true },
    });
    if (!order) throw AppException.notFound('Commande introuvable.');

    if (user.role === Role.CUSTOMER) {
      if (order.customerId !== user.id) {
        throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à cette commande.");
      }

      if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
        throw AppException.conflict(
          ERROR_CODES.ORDER_NOT_CANCELLABLE,
          `Cette commande est ${statusLabel(order.status)} : contactez le restaurant pour l'annuler.`,
        );
      }

      const windowMinutes = this.config.get<number>('orders.customerCancelWindowMinutes') ?? 10;
      const elapsedMinutes = (Date.now() - order.createdAt.getTime()) / 60_000;
      if (elapsedMinutes > windowMinutes) {
        throw AppException.conflict(
          ERROR_CODES.ORDER_NOT_CANCELLABLE,
          `Le délai d'annulation de ${windowMinutes} minutes est dépassé. Contactez le restaurant.`,
        );
      }
    } else if (user.role === Role.DRIVER) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Un livreur ne peut pas annuler une commande.",
      );
    } else {
      this.assertTransitionPermission(user, OrderStatus.CANCELLED);
    }

    assertTransition(order.status, OrderStatus.CANCELLED, order.type);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: dto.reason,
          cancelledById: user.id,
        },
        include: ORDER_DETAIL_INCLUDE,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: OrderStatus.CANCELLED,
          comment: dto.reason,
          actorId: user.id,
        },
      });

      // Une livraison en cours est close proprement.
      if (order.delivery) {
        await tx.delivery.update({
          where: { id: order.delivery.id },
          data: { status: 'FAILED', failedAt: new Date(), failureReason: 'Commande annulée' },
        });
        if (order.delivery.driverId) {
          await tx.driverProfile.update({
            where: { id: order.delivery.driverId },
            data: { isAvailable: true },
          });
        }
      }

      // Le coupon consommé est rendu : la commande n'a pas eu lieu.
      if (order.promotionId) {
        await tx.promotion.update({
          where: { id: order.promotionId },
          data: { usageCount: { decrement: 1 } },
        });
        await tx.couponUsage.deleteMany({ where: { orderId: id } });
      }

      if (order.customerId) {
        await tx.customerProfile.updateMany({
          where: { userId: order.customerId },
          data: { cancelledOrders: { increment: 1 }, ordersCount: { decrement: 1 } },
        });
      }

      if (order.payment && order.payment.status === 'PENDING') {
        await tx.payment.update({
          where: { id: order.payment.id },
          data: {
            status: PaymentStatus.FAILED,
            failureReason: 'Commande annulée',
            events: { create: { label: 'Commande annulée', status: PaymentStatus.FAILED } },
          },
        });
      }

      return result;
    });

    await this.afterStatusChange(updated, OrderStatus.CANCELLED, user, context, dto.reason);

    await this.audit.record({
      actor: user,
      action: 'ORDER_CANCEL',
      module: 'orders',
      entityType: 'Order',
      entityId: id,
      oldValue: { status: order.status },
      newValue: { status: OrderStatus.CANCELLED, reason: dto.reason },
      context,
    });

    return toOrderDetail(updated);
  }

  /**
   * Effets d'une livraison confirmée : chiffre d'affaires du client,
   * fidélité, encaissement du paiement à la livraison.
   */
  /**
   * Annule les commandes en ligne dont le paiement n'est jamais venu.
   *
   * Une commande réglée en ligne attend son paiement avant d'être
   * transmise à la cuisine. Quand le client ferme la page de l'opérateur
   * sans payer — ou perd le réseau, ou change d'avis — elle restait
   * **en attente pour toujours** : dans sa liste de commandes en cours,
   * dans celle du restaurant, avec un panier figé et un coupon consommé.
   * Rien ne la fermait jamais.
   *
   * Passé le délai, elle est annulée comme le ferait le client, avec les
   * mêmes restitutions — coupon rendu, compteurs corrigés, paiement
   * marqué échoué — et le client en est prévenu : sa commande n'a pas
   * disparu, elle a expiré, et il peut la recommander.
   *
   * @returns Le nombre de commandes expirées.
   */
  async expireUnpaid(delayMinutes: number): Promise<number> {
    const limite = new Date(Date.now() - delayMinutes * 60_000);

    const perimees = await this.prisma.order.findMany({
      where: {
        deletedAt: null,
        status: OrderStatus.PENDING,
        paymentMethod: { not: PaymentMethod.CASH_ON_DELIVERY },
        paymentStatus: { not: PaymentStatus.PAID },
        createdAt: { lt: limite },
      },
      select: { id: true, customerId: true, promotionId: true, reference: true, restaurantId: true },
    });

    for (const commande of perimees) {
      const motif = `Paiement non reçu sous ${delayMinutes} minutes`;

      const updated = await this.prisma.transaction(async (tx) => {
        const result = await tx.order.update({
          where: { id: commande.id },
          data: {
            status: OrderStatus.CANCELLED,
            cancelledAt: new Date(),
            cancellationReason: motif,
          },
          include: ORDER_DETAIL_INCLUDE,
        });

        await tx.orderStatusHistory.create({
          data: { orderId: commande.id, status: OrderStatus.CANCELLED, comment: motif },
        });

        if (commande.promotionId) {
          await tx.promotion.update({
            where: { id: commande.promotionId },
            data: { usageCount: { decrement: 1 } },
          });
          await tx.couponUsage.deleteMany({ where: { orderId: commande.id } });
        }

        if (commande.customerId) {
          await tx.customerProfile.updateMany({
            where: { userId: commande.customerId },
            data: { cancelledOrders: { increment: 1 }, ordersCount: { decrement: 1 } },
          });
        }

        await tx.payment.updateMany({
          where: { orderId: commande.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, failureReason: motif },
        });

        return result;
      });

      this.realtime.orderUpdated({
        ...toOrderSummary(updated),
        customerId: updated.customerId,
        restaurantId: updated.restaurantId,
        status: toWire(OrderStatus.CANCELLED),
      });

      if (commande.customerId) {
        await this.notifications.notify({
          userId: commande.customerId,
          type: NotificationType.ORDER_CANCELLED,
          title: 'Commande expirée',
          body:
            `Le paiement de la commande ${commande.reference} n’est pas arrivé : ` +
            'elle a été annulée. Vous pouvez la recommander à tout moment.',
          entityId: commande.id,
        });
      }
    }

    return perimees.length;
  }

  /**
   * Ferme la course d'une commande qui vient de se terminer.
   *
   * Une commande a deux vies parallèles : la sienne, et celle de sa
   * course. Elles étaient tenues séparément, et pouvaient diverger :
   * une commande marquée « livrée » depuis le back-office laissait sa
   * course « sur place » — le livreur voyait encore un bouton « Confirmer
   * la remise » sur une commande que le client, lui, voyait livrée
   * depuis la veille. Quel que soit le chemin qui termine la commande,
   * sa course se termine avec elle, et le livreur est libéré.
   */
  private async closeDeliveryWith(
    tx: Prisma.TransactionClient,
    orderId: string,
    target: OrderStatus,
    comment?: string | null,
  ): Promise<void> {
    if (target !== OrderStatus.DELIVERED && target !== OrderStatus.CANCELLED) return;

    const delivery = await tx.delivery.findUnique({
      where: { orderId },
      select: { id: true, status: true, driverId: true },
    });
    if (!delivery) return;
    if (delivery.status === DeliveryStatus.DELIVERED || delivery.status === DeliveryStatus.FAILED) {
      return;
    }

    const now = new Date();
    const livree = target === OrderStatus.DELIVERED;

    await tx.delivery.update({
      where: { id: delivery.id },
      data: livree
        ? { status: DeliveryStatus.DELIVERED, deliveredAt: now }
        : { status: DeliveryStatus.FAILED, failedAt: now, failureReason: comment ?? 'Commande annulée' },
    });

    await tx.deliveryEvent.create({
      data: {
        deliveryId: delivery.id,
        status: livree ? DeliveryStatus.DELIVERED : DeliveryStatus.FAILED,
        comment: livree ? 'Commande marquée livrée' : (comment ?? 'Commande annulée'),
      },
    });

    // Le livreur redevient disponible : sa course n'existe plus.
    if (delivery.driverId) {
      await tx.driverProfile.update({
        where: { id: delivery.driverId },
        data: { isAvailable: true },
      });
    }
  }

  private async settleOnDelivery(
    tx: Prisma.TransactionClient,
    orderId: string,
    customerId: string | null,
    total: number,
    method: PaymentMethod,
  ): Promise<void> {
    // Sans compte client, il n'y a ni cumul dépensé ni fidélité à créditer.
    if (customerId) {
      await tx.customerProfile.updateMany({
        where: { userId: customerId },
        data: {
          totalSpent: { increment: total },
          // 1 point de fidélité par tranche de 10 000 GNF.
          loyaltyPoints: { increment: Math.floor(total / 10_000) },
        },
      });
    }

    if (method !== PaymentMethod.CASH_ON_DELIVERY) return;

    const paidAt = new Date();

    await tx.payment.updateMany({
      where: { orderId, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
      data: { status: PaymentStatus.PAID, paidAt },
    });

    const payment = await tx.payment.findUnique({ where: { orderId } });
    if (payment) {
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          label: 'Encaissé à la livraison',
          status: PaymentStatus.PAID,
        },
      });
    }

    // La commande porte une copie du statut de paiement : elle doit suivre,
    // quel que soit le chemin qui a mené à la livraison (back-office ou
    // confirmation par code du livreur).
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: PaymentStatus.PAID },
    });
  }

  /** Notifications, temps réel et audit après un changement de statut. */
  private async afterStatusChange(
    order: Awaited<ReturnType<OrdersService['findOneRaw']>>,
    status: OrderStatus,
    actor: AuthenticatedUser,
    context: RequestContext,
    comment?: string,
  ): Promise<void> {
    const summary = toOrderSummary(order);

    // La matière quitte la réserve quand la cuisine s'y met : ni à la prise
    // de commande — elle peut encore être annulée — ni à la livraison, où
    // le plat est déjà cuit depuis longtemps.
    if (status === OrderStatus.PREPARING) {
      await this.recipes.consumeForOrder(order.id, actor.id);
    }

    this.realtime.orderStatusUpdated({
      ...summary,
      customerId: order.customerId,
      status: toWire(status),
      driverProfileId: order.delivery?.driverId ?? null,
    });

    const messages: Partial<Record<OrderStatus, { type: NotificationType; title: string; body: string }>> = {
      [OrderStatus.CONFIRMED]: {
        type: NotificationType.ORDER_CONFIRMED,
        title: 'Commande confirmée',
        body: `Votre commande ${order.reference} est confirmée.`,
      },
      [OrderStatus.PREPARING]: {
        type: NotificationType.ORDER_PREPARING,
        title: 'En préparation',
        body: `La cuisine prépare votre commande ${order.reference}.`,
      },
      [OrderStatus.READY]: {
        type: NotificationType.ORDER_READY,
        title: 'Commande prête',
        body:
          order.type === OrderType.PICKUP
            ? `Votre commande ${order.reference} vous attend au restaurant.`
            : `Votre commande ${order.reference} est prête, un livreur va la prendre en charge.`,
      },
      [OrderStatus.OUT_FOR_DELIVERY]: {
        type: NotificationType.ORDER_OUT_FOR_DELIVERY,
        title: 'En route',
        body: `Votre commande ${order.reference} est en chemin.`,
      },
      [OrderStatus.DELIVERED]: {
        type: NotificationType.ORDER_DELIVERED,
        title: 'Bon appétit !',
        body: `Votre commande ${order.reference} a été livrée.`,
      },
      [OrderStatus.CANCELLED]: {
        type: NotificationType.ORDER_CANCELLED,
        title: 'Commande annulée',
        body: `Votre commande ${order.reference} a été annulée. ${comment ?? ''}`.trim(),
      },
    };

    const message = messages[status];
    if (message && order.customerId) {
      await this.notifications.notify({
        userId: order.customerId,
        type: message.type,
        title: message.title,
        body: message.body,
        entityId: order.id,
        link: `/orders/${order.id}`,
      });
    }

    if (status !== OrderStatus.CANCELLED) {
      await this.audit.record({
        actor,
        action: 'ORDER_STATUS_UPDATE',
        module: 'orders',
        entityType: 'Order',
        entityId: order.id,
        newValue: { status, comment: comment ?? null },
        context,
      });
    }
  }

  /** Utilisé par les autres services (livraisons, paiements). */
  async findOneRaw(id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: ORDER_DETAIL_INCLUDE,
    });
    if (!order) throw AppException.notFound('Commande introuvable.');
    return order;
  }

  /**
   * Transition déclenchée par le cycle de vie d'une livraison
   * (le livreur a récupéré la commande, il l'a remise au client).
   * Elle contourne les permissions du back-office, mais pas la machine
   * à états : une transition impossible reste impossible.
   */
  async applySystemTransition(
    orderId: string,
    target: OrderStatus,
    actor: AuthenticatedUser,
    context: RequestContext,
    comment?: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { delivery: true },
    });
    if (!order) throw AppException.notFound('Commande introuvable.');

    if (order.status === target) return this.findOneRaw(orderId);

    assertTransition(order.status, target, order.type);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id: orderId },
        data: {
          status: target,
          ...(target === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
        },
        include: ORDER_DETAIL_INCLUDE,
      });

      await tx.orderStatusHistory.create({
        data: { orderId, status: target, comment, actorId: actor.id },
      });

      if (target === OrderStatus.DELIVERED) {
        await this.settleOnDelivery(
          tx,
          orderId,
          result.customerId,
          result.total,
          order.paymentMethod,
        );
      }

      return result;
    });

    await this.afterStatusChange(updated, target, actor, context, comment);
    return updated;
  }

  // ──────────────────────────────── Filtres ───────────────────────────────

  private buildBackOfficeWhere(query: OrderQueryDto): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = { deletedAt: null };

    const status = parseEnum(OrderStatus, query.status);
    if (status) where.status = status;

    const paymentStatus = parseEnum(PaymentStatus, query.paymentStatus);
    if (paymentStatus) where.paymentStatus = paymentStatus;

    const type = parseEnum(OrderType, query.type);
    if (type) where.type = type;

    const channel = parseEnum(OrderChannel, query.channel);
    if (channel) where.channel = channel;

    if (query.customerId && query.customerId !== 'all') where.customerId = query.customerId;

    if (query.driverId && query.driverId !== 'all') {
      where.delivery = { driverId: query.driverId };
    }

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { reference: { contains: query.search, mode: 'insensitive' } },
        { customer: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { customer: { lastName: { contains: query.search, mode: 'insensitive' } } },
        { customer: { phone: { contains: query.search } } },
        { walkInName: { contains: query.search, mode: 'insensitive' } },
        { walkInPhone: { contains: query.search } },
      ];
    }

    return where;
  }

  private buildOrder(query: OrderQueryDto): Prisma.OrderOrderByWithRelationInput {
    const direction = query.sortOrder ?? 'desc';
    switch (query.sortBy) {
      case 'total':
        return { total: direction };
      case 'status':
        return { status: direction };
      case 'reference':
        return { reference: direction };
      default:
        return { createdAt: direction };
    }
  }

  private async assertPaymentMethodEnabled(method: PaymentMethod): Promise<void> {
    const settings = await this.settings.getSystemSettings();

    const disabled =
      (method === PaymentMethod.ORANGE_MONEY && !settings.orangeMoneyEnabled) ||
      (method === PaymentMethod.MTN_MONEY && !settings.mtnMoneyEnabled) ||
      (method === PaymentMethod.CARD && !settings.cardPaymentEnabled);

    if (disabled) {
      throw AppException.conflict(
        ERROR_CODES.PAYMENT_METHOD_DISABLED,
        "Ce moyen de paiement n'est pas disponible actuellement.",
      );
    }
  }
}
