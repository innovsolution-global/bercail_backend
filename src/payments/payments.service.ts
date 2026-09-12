import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  OrderStatus,
  Payment,
  PaymentEvent,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ChapChapService } from './chapchap.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { IdempotencyService } from '../common/services/idempotency.service';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { formatAmount } from '../common/utils/money.util';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { InitiatePaymentDto, PaymentQueryDto, RefundPaymentDto } from './dto/payment.dto';

/** Motif inscrit au journal quand le client referme la page de paiement. */
const ABANDON_REASON = 'Paiement abandonné par le client';

type PaymentRow = Payment & {
  order?: { id: string; reference: string; status: OrderStatus } | null;
  customer?: Pick<User, 'id' | 'firstName' | 'lastName'> | null;
  events?: PaymentEvent[];
};

/**
 * Paiements.
 *
 * Le montant payé n'est jamais celui annoncé par le client : il est relu
 * sur la commande. Un paiement mobile passe par un fournisseur externe
 * (Orange Money, MTN) ; en environnement de développement, ce fournisseur
 * est simulé pour que le parcours complet soit testable sans contrat
 * marchand.
 *
 * Le remboursement est une opération sensible : permission dédiée,
 * transaction, audit systématique.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly chapchap: ChapChapService,
    private readonly config: ConfigService,
  ) {}

  private get sandbox(): boolean {
    return this.config.get<boolean>('payment.sandbox') === true;
  }

  // ─────────────────────────────── Lecture ────────────────────────────────

  async list(query: PaymentQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.PaymentWhereInput = {};

    const status = parseEnum(PaymentStatus, query.status);
    if (status) where.status = status;

    const method = parseEnum(PaymentMethod, query.method);
    if (method) where.method = method;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { transactionRef: { contains: query.search, mode: 'insensitive' } },
        { providerRef: { contains: query.search, mode: 'insensitive' } },
        { order: { reference: { contains: query.search, mode: 'insensitive' } } },
        { customer: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { customer: { lastName: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: {
          order: { select: { id: true, reference: true, status: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        order: { select: { id: true, reference: true, status: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!payment) throw AppException.notFound('Paiement introuvable.');

    const isBackOffice = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;
    if (!isBackOffice && payment.customerId !== user.id) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à ce paiement.");
    }

    return this.toDto(payment);
  }

  /** Paiement d'une commande, vu par son client. */
  async findForOrder(user: AuthenticatedUser, orderId: string) {
    // Avant de répondre, on rattrape un éventuel rappel manqué : c'est
    // cette route que l'application interroge pendant que le client
    // règle, donc le meilleur endroit pour combler le silence.
    await this.reconcileWithOperator(orderId);

    const payment = await this.prisma.payment.findUnique({
      where: { orderId },
      include: {
        order: { select: { id: true, reference: true, status: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!payment) throw AppException.notFound('Paiement introuvable.');

    const isBackOffice = user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN;
    if (!isBackOffice && payment.customerId !== user.id) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à ce paiement.");
    }

    return this.toDto(payment);
  }

  // ────────────────────────────── Encaissement ────────────────────────────

  /**
   * Déclenche le paiement d'une commande.
   *
   * Le montant vient de la commande, jamais du corps de la requête. En
   * paiement à la livraison, il n'y a rien à déclencher : l'encaissement
   * a lieu à la remise du repas.
   */
  async initiate(
    user: AuthenticatedUser,
    orderId: string,
    dto: InitiatePaymentDto,
    context: RequestContext,
    idempotencyKey?: string,
  ) {
    return this.idempotency.execute(
      {
        userId: user.id,
        endpoint: 'POST /payments/initiate',
        key: idempotencyKey,
        payload: { orderId, ...dto },
      },
      () => this.doInitiate(user, orderId, dto, context),
    );
  }

  private async doInitiate(
    user: AuthenticatedUser,
    orderId: string,
    dto: InitiatePaymentDto,
    context: RequestContext,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { payment: true },
    });

    if (!order) throw AppException.notFound('Commande introuvable.');

    if (order.customerId !== user.id && user.role === Role.CUSTOMER) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à cette commande.");
    }

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw AppException.conflict(
        ERROR_CODES.PAYMENT_ALREADY_PAID,
        'Cette commande est déjà payée.',
      );
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Cette commande est annulée : elle ne peut plus être payée.',
      );
    }

    if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      throw AppException.badRequest(
        ERROR_CODES.BAD_REQUEST,
        'Cette commande est réglée en espèces à la livraison : aucun paiement en ligne n’est requis.',
      );
    }

    const payment = order.payment;
    if (!payment) throw AppException.notFound('Paiement introuvable pour cette commande.');

    const masked = dto.phone ? this.mask(dto.phone) : null;

    /*
     * Ouverture de l'opération chez l'opérateur.
     *
     * Quand Chap Chap est configuré, c'est lui qui encaisse et qui renvoie
     * la page où le client choisit son moyen de paiement. Sans clés, on
     * retombe sur la référence simulée d'avant — ce qui laisse le bac à
     * sable et les tests fonctionner sans dépendre du réseau.
     */
    let providerRef = `SIM-${payment.transactionRef}`;
    let paymentUrl: string | null = null;

    if (this.chapchap.enabled) {
      const operation = await this.chapchap.createOperation({
        // Notre référence de transaction voyage aller-retour : c'est elle
        // qui nous permettra de reconnaître le paiement au rappel.
        reference: payment.transactionRef,
        amount: payment.amount,
        description: `Commande ${order.reference}`,
        customerPhone: dto.phone ?? null,
        notifyUrl: this.chapchap.notifyUrl(),
        // Pages d'atterrissage : le client ne reste pas devant l'écran de
        // l'opérateur. Elles ne décident de rien — c'est le rappel signé
        // qui marque la commande payée, que le client y arrive ou non.
        returnUrl: this.chapchap.returnUrl(payment.transactionRef),
        cancelUrl: this.chapchap.cancelUrl(payment.transactionRef),
      });

      providerRef = operation.providerRef;
      paymentUrl = operation.paymentUrl;
    }

    // Le fournisseur mobile money confirme de façon asynchrone : on passe
    // en PROCESSING et on attend son rappel (webhook).
    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PROCESSING,
        maskedAccount: masked,
        providerRef,
        events: {
          create: {
            label: `Paiement initié (${toWire(payment.method)})`,
            status: PaymentStatus.PROCESSING,
          },
        },
      },
      include: {
        order: { select: { id: true, reference: true, status: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    await this.prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: PaymentStatus.PROCESSING },
    });

    this.realtime.paymentUpdated({
      id: updated.id,
      orderId,
      customerId: order.customerId,
      status: toWire(PaymentStatus.PROCESSING),
    });

    await this.audit.record({
      actor: user,
      action: 'PAYMENT_INITIATED',
      module: 'payments',
      entityType: 'Payment',
      entityId: payment.id,
      newValue: { orderId, method: payment.method, amount: payment.amount },
      context,
    });

    return {
      ...this.toDto(updated),
      /**
       * Page de paiement à ouvrir pour le client.
       *
       * Nulle sans opérateur configuré : l'application retombe alors sur
       * les instructions ci-dessous.
       */
      paymentUrl,
      /** Instructions destinées à l'application mobile. */
      instructions: paymentUrl
        ? {
            mode: 'redirect',
            message:
              'Ouvrez la page de paiement pour choisir votre opérateur et valider la transaction.',
          }
        : this.sandbox
        ? {
            mode: 'sandbox',
            message:
              "Environnement de démonstration : confirmez le paiement via POST /payments/{id}/confirm pour simuler la validation de l'opérateur.",
          }
        : {
            mode: 'live',
            message: 'Validez la demande de paiement reçue sur votre téléphone.',
          },
    };
  }

  /**
   * Confirmation du paiement.
   *
   * En production, c'est le rappel signé de l'opérateur qui appelle cette
   * logique. En bac à sable, la route de confirmation permet de dérouler
   * le scénario de bout en bout.
   */
  async confirm(
    paymentId: string,
    actor: AuthenticatedUser,
    context: RequestContext,
    providerRef?: string,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment) throw AppException.notFound('Paiement introuvable.');

    if (payment.status === PaymentStatus.PAID) {
      throw AppException.conflict(ERROR_CODES.PAYMENT_ALREADY_PAID, 'Ce paiement est déjà validé.');
    }

    if (payment.status === PaymentStatus.REFUNDED) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce paiement a été remboursé.');
    }

    const isBackOffice = actor.role === Role.ADMIN || actor.role === Role.SUPER_ADMIN;
    if (!isBackOffice && payment.customerId !== actor.id) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à ce paiement.");
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          providerRef: providerRef ?? payment.providerRef,
          events: { create: { label: 'Paiement confirmé', status: PaymentStatus.PAID } },
        },
        include: {
          order: { select: { id: true, reference: true, status: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });

      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: PaymentStatus.PAID },
      });

      return result;
    });

    this.realtime.paymentUpdated({
      id: paymentId,
      orderId: payment.orderId,
      customerId: payment.customerId,
      status: toWire(PaymentStatus.PAID),
    });

    // Une vente au comptoir n'a pas de compte client à prévenir.
    if (payment.customerId) {
      await this.notifications.notify({
        userId: payment.customerId,
        type: NotificationType.PAYMENT_RECEIVED,
        title: 'Paiement confirmé',
        body: `Votre paiement de ${formatAmount(payment.amount)} a bien été reçu.`,
        entityId: payment.orderId,
      });
    }

    await this.audit.record({
      actor,
      action: 'PAYMENT_CONFIRMED',
      module: 'payments',
      entityType: 'Payment',
      entityId: paymentId,
      newValue: { status: PaymentStatus.PAID, amount: payment.amount },
      context,
    });

    await this.announceToKitchen(payment.orderId);

    return this.toDto(updated);
  }

  /**
   * Transmet la commande à la cuisine, une fois l'argent encaissé.
   *
   * Une commande réglée en ligne n'est pas annoncée à sa création : le
   * client peut ouvrir la page de l'opérateur puis se raviser, et le
   * restaurant aurait engagé des denrées pour rien. L'annonce attend
   * donc ce moment-ci, où le paiement est acquis.
   *
   * Un échec ici ne défait pas le paiement : l'argent est encaissé, la
   * commande existe, et elle reste visible dans la liste du back-office
   * même si la notification n'est pas partie. On journalise plutôt que
   * de faire échouer une confirmation d'encaissement.
   */
  private async announceToKitchen(orderId: string): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          customer: { select: { firstName: true, lastName: true, phone: true } },
          _count: { select: { items: true } },
        },
      });

      if (!order) return;

      // Le paiement à la livraison a déjà été annoncé à la création :
      // le ré-annoncer ferait sonner la cuisine deux fois.
      if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) return;

      const customerName = order.customer
        ? `${order.customer.firstName} ${order.customer.lastName}`.trim()
        : (order.walkInName ?? 'Client');

      this.realtime.orderCreated({
        id: order.id,
        customerId: order.customerId,
        reference: order.reference,
        customerName,
        type: toWire(order.type),
        status: toWire(order.status),
        total: order.total,
        paymentStatus: toWire(PaymentStatus.PAID),
        createdAt: order.createdAt.toISOString(),
      });

      await this.notifications.notifyBackOffice(
        {
          type: NotificationType.ORDER_CREATED,
          title: 'Nouvelle commande payée',
          body: `${customerName} — ${formatAmount(order.total)} (${order.reference})`,
          link: `/orders/${order.id}`,
          entityId: order.id,
        },
        // La cuisine qui prépare, et le propriétaire.
        order.restaurantId,
      );
    } catch (error) {
      this.logger.error(
        `Commande ${orderId} payée mais non annoncée à la cuisine : ${(error as Error).message}`,
      );
    }
  }

  /** Échec signalé par l'opérateur. */
  /**
   * Le client a fermé la page de paiement.
   *
   * La page de l'opérateur s'affiche désormais **dans** l'application, et
   * sa croix de fermeture referme la transaction avec elle : sans cela,
   * un paiement resterait « en cours » pour toujours, la commande dans
   * les limbes, et le client verrait « Payer » sur une commande qu'il a
   * lui-même abandonnée.
   *
   * ## L'ordre des deux gestes n'est pas indifférent
   *
   * On **demande d'abord son état à l'opérateur**. Fermer la page une
   * seconde après avoir validé chez Orange ou Kulu est le geste le plus
   * naturel du monde ; déclarer alors l'argent perdu serait une faute
   * lourde — le client aurait payé une commande marquée en échec. Un
   * paiement déjà abouti est donc rendu tel quel, et la fermeture n'y
   * touche pas.
   *
   * Aucune notification « Paiement refusé » n'est envoyée : le client
   * vient de fermer la page, il n'a pas à l'apprendre de nous.
   */
  async abandon(paymentId: string, user: AuthenticatedUser, context: RequestContext) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw AppException.notFound('Paiement introuvable.');

    if (payment.customerId !== user.id) {
      throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à ce paiement.");
    }

    await this.reconcileWithOperator(payment.orderId);

    const apresReconciliation = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    const tranche =
      apresReconciliation !== null &&
      apresReconciliation.status !== PaymentStatus.PENDING &&
      apresReconciliation.status !== PaymentStatus.PROCESSING;

    // Déjà payé, déjà en échec, déjà remboursé : il n'y a rien à
    // abandonner, et l'état réel prime sur le geste de fermeture.
    if (tranche) return this.findForOrder(user, payment.orderId);

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: ABANDON_REASON,
          events: { create: { label: ABANDON_REASON, status: PaymentStatus.FAILED } },
        },
        include: {
          order: { select: { id: true, reference: true, status: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });

      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });

      return result;
    });

    await this.audit.record({
      actor: user,
      action: 'PAYMENT_ABANDONED',
      module: 'payments',
      entityType: 'Payment',
      entityId: paymentId,
      newValue: { reason: ABANDON_REASON },
      context,
    });

    return this.toDto(updated);
  }

  async markFailed(paymentId: string, reason: string, actor: AuthenticatedUser, context: RequestContext) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw AppException.notFound('Paiement introuvable.');

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: reason,
          events: { create: { label: `Échec : ${reason}`, status: PaymentStatus.FAILED } },
        },
        include: {
          order: { select: { id: true, reference: true, status: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });

      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });

      return result;
    });

    if (payment.customerId) {
      await this.notifications.notify({
        userId: payment.customerId,
        type: NotificationType.PAYMENT_FAILED,
        title: 'Paiement refusé',
        body: `Votre paiement n'a pas abouti : ${reason}`,
        entityId: payment.orderId,
      });
    }

    await this.audit.record({
      actor,
      action: 'PAYMENT_FAILED',
      module: 'payments',
      entityType: 'Payment',
      entityId: paymentId,
      newValue: { reason },
      context,
    });

    return this.toDto(updated);
  }

  /**
   * Remboursement — opération sensible.
   *
   * Seul un paiement effectivement encaissé peut être remboursé, une
   * seule fois, avec un motif obligatoire. L'audit conserve le montant,
   * le motif et l'auteur.
   */
  async refund(
    id: string,
    dto: RefundPaymentDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { order: true },
    });

    if (!payment) throw AppException.notFound('Paiement introuvable.');

    if (payment.status === PaymentStatus.REFUNDED) {
      throw AppException.conflict(
        ERROR_CODES.PAYMENT_NOT_REFUNDABLE,
        'Ce paiement a déjà été remboursé.',
      );
    }

    if (payment.status !== PaymentStatus.PAID) {
      throw AppException.conflict(
        ERROR_CODES.PAYMENT_NOT_REFUNDABLE,
        "Seul un paiement encaissé peut être remboursé.",
      );
    }

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
          refundReason: dto.reason,
          refundedById: actor.id,
          events: {
            create: { label: `Remboursement : ${dto.reason}`, status: PaymentStatus.REFUNDED },
          },
        },
        include: {
          order: { select: { id: true, reference: true, status: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });

      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: PaymentStatus.REFUNDED },
      });

      // Le chiffre d'affaires du client est corrigé : un montant remboursé
      // n'est plus une dépense. Sans compte client, il n'y a rien à corriger.
      if (payment.customerId) {
        await tx.customerProfile.updateMany({
          where: { userId: payment.customerId },
          data: { totalSpent: { decrement: payment.amount } },
        });
      }

      return result;
    });

    this.realtime.paymentUpdated({
      id,
      orderId: payment.orderId,
      customerId: payment.customerId,
      status: toWire(PaymentStatus.REFUNDED),
    });

    if (payment.customerId) {
      await this.notifications.notify({
        userId: payment.customerId,
        type: NotificationType.PAYMENT_RECEIVED,
        title: 'Remboursement effectué',
        body: `Un remboursement de ${formatAmount(payment.amount)} a été émis. ${dto.reason}`,
        entityId: payment.orderId,
      });
    }

    await this.audit.record({
      actor,
      action: 'PAYMENT_REFUND',
      module: 'payments',
      entityType: 'Payment',
      entityId: id,
      oldValue: { status: payment.status, amount: payment.amount },
      newValue: { status: PaymentStatus.REFUNDED, reason: dto.reason },
      context,
    });

    this.logger.warn(
      `Remboursement de ${payment.amount} GNF sur ${payment.transactionRef} par ${actor.email}.`,
    );

    return this.toDto(updated);
  }

  /** Export comptable. */
  async exportRows(query: PaymentQueryDto) {
    const result = await this.list({ ...query, page: 1, limit: 100 } as PaymentQueryDto);
    return result.data as Record<string, unknown>[];
  }

  // ──────────────────────────────── Outils ────────────────────────────────

  /** Un numéro ne doit jamais être stocké ni renvoyé en entier. */
  private mask(value: string): string {
    const trimmed = value.replace(/\s/g, '');
    if (trimmed.length <= 4) return `****`;
    return `${trimmed.slice(0, 3)}****${trimmed.slice(-2)}`;
  }

  private toDto(payment: PaymentRow) {
    return {
      id: payment.id,
      transactionRef: payment.transactionRef,
      orderId: payment.orderId,
      orderReference: payment.order?.reference ?? '',
      customerId: payment.customerId,
      customerName: payment.customer
        ? `${payment.customer.firstName} ${payment.customer.lastName}`.trim()
        : '',
      method: toWire(payment.method),
      status: toWire(payment.status),
      amount: payment.amount,
      fee: payment.fee,
      maskedAccount: payment.maskedAccount,
      providerRef: payment.providerRef,
      paidAt: payment.paidAt?.toISOString() ?? null,
      refundedAt: payment.refundedAt?.toISOString() ?? null,
      refundReason: payment.refundReason,
      failureReason: payment.failureReason,
      history: (payment.events ?? []).map((event) => ({
        label: event.label,
        at: event.createdAt.toISOString(),
        status: toWire(event.status),
      })),
      createdAt: payment.createdAt.toISOString(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Chap Chap Pay                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Applique le dénouement annoncé par Chap Chap.
   *
   * Appelée par le rappel, dont la signature a déjà été vérifiée. Trois
   * précautions gouvernent ce traitement :
   *
   *  • **Idempotence.** Un opérateur réessaie tant qu'il n'a pas d'accusé,
   *    et rejoue parfois un rappel déjà traité. Un paiement déjà encaissé
   *    n'est pas encaissé une seconde fois — sans quoi le chiffre
   *    d'affaires du jour compterait la même vente deux fois.
   *
   *  • **Le montant est relu chez nous.** Ce que le rappel annonce n'est
   *    pas ce qui fait le montant de la commande : on ne fait qu'y lire un
   *    statut. Un rappel ne peut donc pas modifier ce qui est dû.
   *
   *  • **On ne lève pas d'erreur sur un rappel inconnu.** Répondre en échec
   *    ferait réessayer l'opérateur indéfiniment pour une transaction qui
   *    ne nous concerne pas.
   */
  async applyChapChapCallback(payload: Record<string, unknown>): Promise<void> {
    const reference = this.readString(payload, [
      'reference',
      'merchant_reference',
      'merchantReference',
      'order_reference',
      'orderReference',
    ]);

    const providerRef = this.readString(payload, [
      'transaction_id',
      'transactionId',
      'operation_id',
      'operationId',
      'id',
    ]);

    if (!reference && !providerRef) {
      this.logger.warn('Rappel Chap Chap sans référence exploitable : ignoré.');
      return;
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          ...(reference ? [{ transactionRef: reference }] : []),
          ...(providerRef ? [{ providerRef }] : []),
        ],
      },
    });

    if (!payment) {
      this.logger.warn(
        `Rappel Chap Chap pour une transaction inconnue (${reference ?? providerRef}) : ignoré.`,
      );
      return;
    }

    const outcome = this.readChapChapStatus(payload);

    if (outcome === 'unknown') {
      this.logger.warn(
        `Rappel Chap Chap au statut non reconnu pour ${payment.transactionRef} : ${JSON.stringify(payload).slice(0, 200)}`,
      );
      return;
    }

    // Déjà dans l'état annoncé : le rappel est un doublon.
    if (
      (outcome === 'paid' && payment.status === PaymentStatus.PAID) ||
      (outcome === 'failed' && payment.status === PaymentStatus.FAILED)
    ) {
      return;
    }

    // Un paiement déjà encaissé ne redevient pas en échec sur un rappel
    // tardif : seul un remboursement peut défaire un encaissement.
    if (payment.status === PaymentStatus.PAID && outcome === 'failed') {
      this.logger.warn(
        `Rappel d'échec ignoré : le paiement ${payment.transactionRef} est déjà encaissé.`,
      );
      return;
    }

    const operator: AuthenticatedUser = {
      id: payment.customerId ?? 'chapchap',
      email: 'chapchap@operateur',
      role: Role.SUPER_ADMIN,
      status: 'ACTIVE',
      firstName: 'Chap Chap',
      lastName: 'Pay',
      permissions: [],
      mustChangePassword: false,
    } as AuthenticatedUser;

    const context: RequestContext = {
      requestId: `chapchap-${providerRef ?? reference ?? payment.id}`,
      userAgent: 'chapchap-webhook',
    };

    if (outcome === 'paid') {
      await this.confirm(payment.id, operator, context, providerRef ?? undefined);
      return;
    }

    await this.markFailed(
      payment.id,
      this.readString(payload, ['message', 'reason', 'status_message']) ??
        "Transaction refusée par l'opérateur.",
      operator,
      context,
    );
  }

  /** Traduit le statut annoncé par l'opérateur. */
  /**
   * Va chercher chez l'opérateur le dénouement qu'on n'a pas reçu.
   *
   * Le rappel signé reste la voie normale. Celle-ci est le filet : sur
   * une machine de développement, notre serveur n'est joignable de
   * l'extérieur qu'à travers un tunnel, et si personne ne l'a lancé le
   * paiement resterait « en cours » indéfiniment — le client a payé,
   * l'application attend, et rien ne se débloque jamais.
   *
   * On ne demande que pour un paiement réellement en vol : un paiement
   * déjà tranché n'a rien à apprendre, et interroger l'opérateur à
   * chaque lecture coûterait un aller-retour pour rien.
   */
  private async reconcileWithOperator(orderId: string): Promise<void> {
    if (!this.chapchap.enabled) return;

    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (!payment || payment.status !== PaymentStatus.PROCESSING) return;

    const operation = await this.chapchap.readOperation(payment.transactionRef);
    if (!operation) return;

    /*
     * L'état arrive sous la forme `{"status": {"code": "..."}}`, là où
     * le rappel l'envoie à plat. On l'aplatit pour que les deux voies
     * partagent la même lecture — et donc le même vocabulaire de
     * statuts, sans risque qu'elles divergent.
     */
    const status = operation.status;
    const code =
      typeof status === 'object' && status !== null
        ? (status as Record<string, unknown>).code
        : status;

    await this.applyChapChapCallback({
      reference: payment.transactionRef,
      status: code,
      transaction_id: operation.operation_id,
    });
  }

  private readChapChapStatus(payload: Record<string, unknown>): 'paid' | 'failed' | 'unknown' {
    const raw = (
      this.readString(payload, ['status', 'state', 'transaction_status', 'transactionStatus']) ?? ''
    ).toLowerCase();

    if (['success', 'successful', 'succeeded', 'paid', 'completed', 'complete', 'approved', 'ok'].includes(raw)) {
      return 'paid';
    }

    if (['failed', 'failure', 'cancelled', 'canceled', 'declined', 'rejected', 'expired', 'error'].includes(raw)) {
      return 'failed';
    }

    // « pending » et consorts : la transaction n'est pas dénouée, il n'y a
    // rien à écrire. Un autre rappel suivra.
    return 'unknown';
  }

  /** Lit la première clé présente, y compris dans un objet `data` imbriqué. */
  private readString(source: Record<string, unknown>, keys: string[]): string | null {
    const nested = source.data;
    const candidates: Record<string, unknown>[] = [source];
    if (typeof nested === 'object' && nested !== null) {
      candidates.push(nested as Record<string, unknown>);
    }

    for (const candidate of candidates) {
      for (const key of keys) {
        const value = candidate[key];
        if (typeof value === 'string' && value.length > 0) return value;
        if (typeof value === 'number') return String(value);
      }
    }

    return null;
  }

}
