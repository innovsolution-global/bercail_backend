import { NotificationType, OrderStatus, PaymentMethod, PaymentStatus, Role } from '@prisma/client';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { ABANDON_REASON, expiryReason } from '../orders/unpaid-orders';
import { PaymentsService } from './payments.service';

/**
 * Paiement annulé, paiement tardif.
 *
 * Le défaut : fermer la page de paiement marquait le paiement en échec
 * mais laissait la commande « en attente ». Le back-office la voyait
 * comme une autre, et un gérant l'a confirmée et envoyée en cuisine
 * sans qu'un franc soit encaissé (BRC-260914-YWJN).
 */
describe('Paiement annulé, paiement tardif', () => {
  const client = { id: 'u1', role: Role.CUSTOMER, permissions: [] } as unknown as AuthenticatedUser;
  const operateur = { id: 'chapchap', role: Role.SUPER_ADMIN, permissions: [] } as unknown as AuthenticatedUser;
  const contexte = { requestId: 'test' } as RequestContext;

  const ligne = (status: PaymentStatus) => ({
    id: 'p1',
    transactionRef: 'TX-1',
    orderId: 'o1',
    customerId: 'u1',
    method: PaymentMethod.MOBILE_MONEY,
    status,
    amount: 57000,
    fee: 0,
    maskedAccount: null,
    providerRef: null,
    paidAt: null,
    refundedAt: null,
    refundReason: null,
    failureReason: null,
    events: [],
    createdAt: new Date(),
    order: { id: 'o1', reference: 'BRC-260914-YWJN', status: OrderStatus.PENDING, restaurantId: 'r1' },
    customer: { id: 'u1', firstName: 'Awa', lastName: 'Camara' },
  });

  function monter(paiement: PaymentStatus, commande: Record<string, unknown>) {
    const tx = {
      payment: {
        update: jest.fn(async ({ data }: { data: { status: PaymentStatus } }) => ligne(data.status)),
      },
      order: {
        findUnique: jest.fn(async () => commande),
        update: jest.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})),
      },
      orderStatusHistory: { create: jest.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
      promotion: { update: jest.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
      couponUsage: {
        deleteMany: jest.fn(async () => ({ count: 1 })),
        upsert: jest.fn(async (_args: { create: Record<string, unknown> }) => ({})),
      },
      customerProfile: { updateMany: jest.fn(async (_args: { data: Record<string, unknown> }) => ({ count: 1 })) },
    };
    const prisma = {
      payment: { findUnique: jest.fn(async () => ligne(paiement)) },
      // Hors transaction : la relecture de l'annonce en cuisine.
      order: { findUnique: jest.fn(async () => null) },
      transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const notifications = {
      notify: jest.fn(async () => undefined),
      notifyBackOffice: jest.fn(async () => undefined),
    };
    const realtime = { paymentUpdated: jest.fn(), orderCreated: jest.fn() };
    const audit = { record: jest.fn(async () => undefined) };

    const service = new PaymentsService(
      prisma as never,
      notifications as never,
      realtime as never,
      audit as never,
      {} as never, // idempotency
      { enabled: false } as never, // chapchap : pas d'opérateur à interroger
      {} as never, // config
    );

    return { service, prisma, tx, notifications };
  }

  it('fermer la page de paiement annule la commande et rend ce qu’elle retenait', async () => {
    const { service, tx } = monter(PaymentStatus.PROCESSING, {
      status: OrderStatus.PENDING,
      promotionId: 'promo1',
      customerId: 'u1',
    });

    await service.abandon('p1', client, contexte);

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: expect.objectContaining({
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.FAILED,
        cancellationReason: ABANDON_REASON,
      }),
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: OrderStatus.CANCELLED }),
    });
    // Le coupon redevient utilisable, et la fiche client ne compte plus
    // une commande qui n'a pas eu lieu.
    expect(tx.promotion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usageCount: { decrement: 1 } } }),
    );
    expect(tx.couponUsage.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'o1' } });
    expect(tx.customerProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { cancelledOrders: { increment: 1 }, ordersCount: { decrement: 1 } },
      }),
    );
  });

  it('ne touche pas au statut d’une commande qui n’est plus en attente', async () => {
    const { service, tx } = monter(PaymentStatus.PROCESSING, {
      status: OrderStatus.CANCELLED,
      promotionId: null,
      customerId: 'u1',
    });

    await service.abandon('p1', client, contexte);

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { paymentStatus: PaymentStatus.FAILED },
    });
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(tx.customerProfile.updateMany).not.toHaveBeenCalled();
  });

  it('rétablit la commande quand l’argent arrive après la fermeture', async () => {
    const { service, prisma, tx, notifications } = monter(PaymentStatus.FAILED, {
      status: OrderStatus.CANCELLED,
      cancellationReason: ABANDON_REASON,
      customerId: 'u1',
      promotionId: 'promo1',
      discount: 5000,
    });

    await service.confirm('p1', operateur, contexte);

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: {
        paymentStatus: PaymentStatus.PAID,
        status: OrderStatus.PENDING,
        cancelledAt: null,
        cancellationReason: null,
      },
    });
    expect(tx.promotion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usageCount: { increment: 1 } } }),
    );
    expect(tx.couponUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ orderId: 'o1', userId: 'u1', discountAmount: 5000 }),
      }),
    );
    expect(tx.customerProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { cancelledOrders: { decrement: 1 }, ordersCount: { increment: 1 } },
      }),
    );
    // Payée : elle part en cuisine, sans alerte de remboursement.
    expect(prisma.order.findUnique).toHaveBeenCalled();
    expect(notifications.notifyBackOffice).not.toHaveBeenCalled();
  });

  it('rétablit aussi une commande expirée faute de paiement', async () => {
    const { service, tx } = monter(PaymentStatus.FAILED, {
      status: OrderStatus.CANCELLED,
      cancellationReason: expiryReason(45),
      customerId: 'u1',
      promotionId: null,
      discount: 0,
    });

    await service.confirm('p1', operateur, contexte);

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: expect.objectContaining({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.PAID }),
    });
    expect(tx.promotion.update).not.toHaveBeenCalled();
  });

  it('laisse annulée une commande refusée par le restaurant, et demande le remboursement', async () => {
    const { service, prisma, tx, notifications } = monter(PaymentStatus.FAILED, {
      status: OrderStatus.CANCELLED,
      cancellationReason: 'Rupture de stock',
      customerId: 'u1',
      promotionId: null,
      discount: 0,
    });

    await service.confirm('p1', operateur, contexte);

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { paymentStatus: PaymentStatus.PAID },
    });
    // Pas de cuisine pour une commande que le restaurant a refusée…
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    // … mais l'argent est là, et quelqu'un doit le rendre.
    expect(notifications.notifyBackOffice).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.ADMIN_ALERT }),
      'r1',
    );
  });
});
