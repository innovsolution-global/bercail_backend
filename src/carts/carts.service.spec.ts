import { CartsService } from './carts.service';

/**
 * Le panier est chiffré chez la maison qui préparera.
 *
 * C'est lui que l'application montre au moment de payer : ses frais et
 * son minimum doivent être ceux de la cuisine qui recevra la commande —
 * y compris quand celle-ci bascule parce que la maison la plus proche n'a
 * plus l'un des plats.
 */
describe('Panier et cuisine', () => {
  const KIPE = { id: 'kipe', name: 'Le Bercail — Kipé' };
  const KALOUM = { id: 'kaloum', name: 'Le Bercail' };

  function monter(options: {
    choix?: unknown;
    epuisesPartout?: string[];
  } = {}) {
    const lignes = [
      { id: 'l1', menuItemId: 'poulet', quantity: 1, note: null, options: [], menuItem: { id: 'poulet', name: 'Poulet braisé', imageUrl: '', isAvailable: true } },
      { id: 'l2', menuItemId: 'jus', quantity: 2, note: null, options: [], menuItem: { id: 'jus', name: 'Jus', imageUrl: '', isAvailable: true } },
    ];

    const prisma = {
      cart: { findUnique: jest.fn(async () => ({ id: 'cart-1' })) },
      cartItem: { findMany: jest.fn(async () => lignes) },
    };
    const pricing = {
      quote: jest.fn(async (input: { lines: { menuItemId: string }[] }) => ({
        lines: input.lines.map(() => ({ unitPrice: 1000, lineTotal: 1000, options: [] })),
        subtotal: 1000 * input.lines.length,
        deliveryFee: 0,
        discount: 0,
        total: 1000 * input.lines.length,
        promotion: null,
        currency: 'GNF',
        minimumOrder: 0,
        estimatedPreparationMinutes: 20,
      })),
    };
    const availability = {
      soldOutEverywhere: jest.fn(async () => options.epuisesPartout ?? []),
    };
    const kitchens = {
      choose: jest.fn(async () => options.choix ?? { ok: true, restaurant: KIPE, divertedFrom: null }),
    };

    return {
      service: new CartsService(prisma as never, pricing as never, availability as never, kitchens as never),
      pricing,
      kitchens,
    };
  }

  it('chiffre chez la maison qui préparera, et la nomme', async () => {
    const { service, pricing } = monter({
      choix: { ok: true, restaurant: KALOUM, divertedFrom: { ...KIPE, soldOut: [{ id: 'poulet', name: 'Poulet braisé' }] } },
    });

    const panier = await service.get('u1');

    expect(pricing.quote).toHaveBeenCalledWith(expect.objectContaining({ restaurantId: 'kaloum' }));
    expect(panier.kitchen).toEqual({
      id: 'kaloum',
      name: 'Le Bercail',
      divertedFrom: { id: 'kipe', name: 'Le Bercail — Kipé', soldOut: [{ id: 'poulet', name: 'Poulet braisé' }] },
    });
    expect(panier.unavailableItems).toEqual([]);
  });

  it('signale ce qui manque quand aucune maison ne peut tout préparer', async () => {
    // Le poulet manque chez la plus proche et personne d'autre n'a tout :
    // il est signalé indisponible, le reste est chiffré chez elle.
    const { service, pricing } = monter({
      choix: { ok: false, nearest: KIPE, soldOut: [{ id: 'poulet', name: 'Poulet braisé' }] },
    });

    const panier = await service.get('u1');

    expect(panier.unavailableItems).toEqual([{ id: 'l1', menuItemId: 'poulet', name: 'Poulet braisé' }]);
    expect(panier.items.find((item) => item.menuItemId === 'poulet')?.isAvailable).toBe(false);
    expect(panier.items.find((item) => item.menuItemId === 'jus')?.isAvailable).toBe(true);
    expect(pricing.quote).toHaveBeenCalledWith(
      expect.objectContaining({ restaurantId: 'kipe', lines: [expect.objectContaining({ menuItemId: 'jus' })] }),
    );
    expect(panier.kitchen).toMatchObject({ id: 'kipe', divertedFrom: null });
  });

  it('ne demande pas de cuisine pour un plat épuisé partout', async () => {
    const { service, kitchens } = monter({ epuisesPartout: ['poulet'] });

    const panier = await service.get('u1');

    expect(kitchens.choose).toHaveBeenCalledWith(expect.objectContaining({ menuItemIds: ['jus'] }));
    expect(panier.unavailableItems.map((item) => item.menuItemId)).toEqual(['poulet']);
  });
});
