import { OrderChannel, OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

/**
 * Les commandes en ligne jamais payées expirent.
 *
 * Elles restaient « en attente » pour toujours : dans la liste du
 * client, dans celle du restaurant, avec un coupon consommé. Rien ne
 * les fermait.
 */
describe('Expiration des commandes impayées', () => {
  function monter(perimees: Array<Record<string, unknown>>) {
    const tx = {
      order: {
        update: jest.fn(async () => ({
          id: 'o1',
          reference: 'BRC-1',
          customerId: 'u1',
          restaurantId: 'r1',
          status: OrderStatus.CANCELLED,
          type: 'DELIVERY',
          channel: 'APP',
          paymentMethod: PaymentMethod.ORANGE_MONEY,
          paymentStatus: PaymentStatus.FAILED,
          total: 78000,
          subtotal: 60000,
          deliveryFee: 18000,
          discount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
          history: [],
          customer: { id: 'u1', firstName: 'Mariama', lastName: 'Diallo', phone: '', email: '' },
        })),
      },
      orderStatusHistory: { create: jest.fn(async () => ({})) },
      promotion: { update: jest.fn(async () => ({})) },
      couponUsage: { deleteMany: jest.fn(async () => ({ count: 1 })) },
      customerProfile: { updateMany: jest.fn(async () => ({ count: 1 })) },
      payment: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      order: { findMany: jest.fn(async () => perimees) },
      transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const notifications = { notify: jest.fn(async () => undefined) };
    const realtime = { orderUpdated: jest.fn() };

    const service = new OrdersService(
      prisma as never,
      {} as never, // pricing
      {} as never, // settings
      notifications as never,
      realtime as never,
      {} as never, // audit
      {} as never, // idempotency
      {} as never, // recipes
      {} as never, // config
      {} as never, // router
      {} as never, // kitchens
    );

    return { service, prisma, tx, notifications };
  }

  it('ne vise que les commandes en ligne, en attente ou confirmées, non payées, assez anciennes', async () => {
    const { service, prisma } = monter([]);

    await service.expireUnpaid(45);

    const appel = (prisma.order.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>)[0][0];
    const where = appel.where;
    // Une vente au comptoir « à payer plus tard » n'attend aucun
    // opérateur : elle ne doit jamais expirer pour cette raison.
    expect(where.channel).toBe(OrderChannel.ONLINE);
    // Confirmée sans paiement : un reliquat d'avant la garde, à fermer
    // comme les autres plutôt qu'à laisser afficher « Confirmée ».
    expect(where.status).toEqual({ in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] });
    // Une commande en espèces n'attend aucun paiement : elle ne doit
    // jamais expirer pour cette raison.
    expect(where.paymentMethod).toEqual({ not: PaymentMethod.CASH_ON_DELIVERY });
    // Une commande payée est à la cuisine : on ne l'annule pas.
    expect(where.paymentStatus).toEqual({ not: PaymentStatus.PAID });
    expect(where.createdAt).toHaveProperty('lt');
  });

  it('annule, rend le coupon, marque le paiement échoué et prévient le client', async () => {
    const { service, tx, notifications } = monter([
      { id: 'o1', customerId: 'u1', promotionId: 'p1', reference: 'BRC-1', restaurantId: 'r1' },
    ]);

    const count = await service.expireUnpaid(45);

    expect(count).toBe(1);
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.CANCELLED }),
      }),
    );
    expect(tx.promotion.update).toHaveBeenCalled();
    expect(tx.couponUsage.deleteMany).toHaveBeenCalled();
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.FAILED }),
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', title: 'Commande expirée' }),
    );
  });

  it('ne fait rien quand rien n’a expiré', async () => {
    const { service, tx } = monter([]);

    expect(await service.expireUnpaid(45)).toBe(0);
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
