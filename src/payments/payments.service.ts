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

    // Le fournisseur mobile money confirme de façon asynchrone : on passe
    // en PROCESSING et on attend son rappel (webhook).
    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PROCESSING,
        maskedAccount: masked,
        providerRef: `SIM-${payment.transactionRef}`,
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
      /** Instructions destinées à l'application mobile. */
      instructions: this.sandbox
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

    return this.toDto(updated);
  }

  /** Échec signalé par l'opérateur. */
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
}
