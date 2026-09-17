import {
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  Role,
  type Prisma,
} from '@prisma/client';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { OrdersService } from './orders.service';
import {
  ABANDON_REASON,
  UNPAID_ONLINE,
  cancelledForNonPayment,
  expiryReason,
  isUnpaidOnline,
} from './unpaid-orders';

/**
 * Pas de cuisine sans argent.
 *
 * Une commande au paiement annulé est restée visible dans le back-office,
 * et le serveur a accepté qu'un gérant la confirme : elle est partie en
 * préparation sans qu'un franc soit encaissé.
 */
describe('Commandes en ligne non payées', () => {
  const gerant = { id: 'a1', role: Role.SUPER_ADMIN, permissions: [] } as unknown as AuthenticatedUser;
  const contexte = { requestId: 'test' } as RequestContext;

  function monter(commande: Record<string, unknown> | null = null) {
    const prisma = {
      order: { findFirst: jest.fn(async () => commande) },
      transaction: jest.fn(async () => {
        throw new Error('aucune écriture attendue');
      }),
    };

    const service = new OrdersService(
      prisma as never,
      {} as never, // pricing
      {} as never, // settings
      {} as never, // notifications
      {} as never, // realtime
      {} as never, // audit
      {} as never, // idempotency
      {} as never, // recipes
      {} as never, // config
      {} as never, // router
      {} as never, // kitchens
    );

    return { service, prisma };
  }

  it('refuse de confirmer une commande en ligne dont le paiement a été annulé', async () => {
    const { service, prisma } = monter({
      id: 'o1',
      status: OrderStatus.PENDING,
      type: OrderType.DELIVERY,
      channel: OrderChannel.ONLINE,
      paymentMethod: PaymentMethod.MOBILE_MONEY,
      paymentStatus: PaymentStatus.FAILED,
      delivery: null,
    });

    const erreur = await service
      .updateStatus(gerant, 'o1', { status: 'confirmed' } as never, contexte)
      .catch((e: unknown) => e);

    const reponse = (erreur as { getResponse?: () => unknown }).getResponse?.() ?? String(erreur);
    expect(JSON.stringify(reponse)).toContain('pas payée');
    expect(prisma.transaction).not.toHaveBeenCalled();
  });

  it('ne retient que les commandes à régler en ligne et non encaissées', () => {
    const commande = (
      channel: OrderChannel,
      paymentMethod: PaymentMethod,
      paymentStatus: PaymentStatus,
    ) => ({ channel, paymentMethod, paymentStatus });

    // Espèces à la livraison : l'argent arrive avec le livreur, la
    // cuisine n'a pas à l'attendre.
    expect(
      isUnpaidOnline(commande(OrderChannel.ONLINE, PaymentMethod.CASH_ON_DELIVERY, PaymentStatus.PENDING)),
    ).toBe(false);
    // Au comptoir, la caisse encaisse elle-même.
    expect(
      isUnpaidOnline(commande(OrderChannel.POS, PaymentMethod.MOBILE_MONEY, PaymentStatus.PENDING)),
    ).toBe(false);
    expect(
      isUnpaidOnline(commande(OrderChannel.ONLINE, PaymentMethod.MOBILE_MONEY, PaymentStatus.PAID)),
    ).toBe(false);

    expect(
      isUnpaidOnline(commande(OrderChannel.ONLINE, PaymentMethod.MOBILE_MONEY, PaymentStatus.FAILED)),
    ).toBe(true);
    expect(
      isUnpaidOnline(commande(OrderChannel.ONLINE, PaymentMethod.ORANGE_MONEY, PaymentStatus.PROCESSING)),
    ).toBe(true);
  });

  it('les écarte de la liste du back-office, sauf filtre de paiement explicite', () => {
    const { service } = monter();
    const construire = (query: object) =>
      (
        service as unknown as { buildBackOfficeWhere(q: object): Prisma.OrderWhereInput }
      ).buildBackOfficeWhere(query);

    expect(construire({}).NOT).toEqual(UNPAID_ONLINE);
    expect(construire({ paymentStatus: 'all' }).NOT).toEqual(UNPAID_ONLINE);
    // Une valeur inconnue ne doit pas les faire réapparaître.
    expect(construire({ paymentStatus: 'nimporte' }).NOT).toEqual(UNPAID_ONLINE);

    const abandons = construire({ paymentStatus: 'failed' });
    expect(abandons.NOT).toBeUndefined();
    expect(abandons.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('distingue les annulations du parcours de paiement de celles du restaurant', () => {
    expect(cancelledForNonPayment(ABANDON_REASON)).toBe(true);
    expect(cancelledForNonPayment(expiryReason(45))).toBe(true);
    expect(cancelledForNonPayment('Rupture de stock')).toBe(false);
    expect(cancelledForNonPayment(null)).toBe(false);
  });
});
