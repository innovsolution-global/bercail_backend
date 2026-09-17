import { OrderType } from '@prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { KitchenSelector } from './kitchen-selector.service';

/**
 * Quelle cuisine prépare une commande quand la plus proche n'a plus tout.
 *
 * Décision du propriétaire, le 14 septembre 2026 : la rupture est propre
 * à chaque maison — un gérant qui marque un plat « épuisé » ne le fait que
 * chez lui — et, quand cela arrive, **la commande bascule d'elle-même chez
 * la maison qui a le plat**. Le client n'a rien à refaire.
 */
describe('Choix de la cuisine', () => {
  const KALOUM = {
    id: 'kaloum',
    name: 'Le Bercail',
    latitude: 9.509167,
    longitude: -13.712222,
    isOpen: true,
    deliveryEnabled: true,
    pickupEnabled: true,
    openingHours: [],
  };
  const KIPE = { ...KALOUM, id: 'kipe', name: 'Le Bercail — Kipé', latitude: 9.639167, longitude: -13.622222 };
  const LAMBANYI = { ...KALOUM, id: 'lambanyi', name: 'Le Bercail — Lambanyi', latitude: 9.62, longitude: -13.6 };

  type Maison = typeof KALOUM;
  type Rupture = { menuItemId: string; restaurantId: string };

  function monter(options: {
    maisons?: Maison[];
    ruptures?: Rupture[];
    fermees?: string[];
  } = {}) {
    const maisons = options.maisons ?? [KALOUM, KIPE, LAMBANYI];
    const fermees = new Set(options.fermees ?? []);
    const noms: Record<string, string> = { poulet: 'Poulet braisé', jus: 'Jus de gingembre' };

    const prisma = {
      menuItemStockout: {
        findMany: jest.fn(async ({ where }: { where: { menuItemId: { in: string[] } } }) =>
          (options.ruptures ?? [])
            .filter((r) => where.menuItemId.in.includes(r.menuItemId))
            .map((r) => ({ ...r, menuItem: { name: noms[r.menuItemId] ?? r.menuItemId } })),
        ),
      },
    };

    const settings = {
      byId: jest.fn(async (id: string) => {
        const maison = maisons.find((m) => m.id === id);
        if (!maison) throw AppException.notFound('Cet établissement n’est plus ouvert.');
        return maison;
      }),
      getRestaurantCached: jest.fn(async () => maisons[0]),
      isOpenNow: jest.fn((maison: Maison) => !fermees.has(maison.id)),
    };

    const router = {
      closestFirst: jest.fn(async (point: { latitude: number; longitude: number }) =>
        [...maisons]
          .map((m) => ({ id: m.id, d: (m.latitude - point.latitude) ** 2 + (m.longitude - point.longitude) ** 2 }))
          .sort((a, b) => a.d - b.d)
          .map((m) => m.id),
      ),
    };

    return {
      selector: new KitchenSelector(prisma as never, settings as never, router as never),
      settings,
      router,
    };
  }

  const pres = (maison: Maison) => ({ latitude: maison.latitude + 0.001, longitude: maison.longitude });

  it('garde la maison la plus proche quand elle a tout', async () => {
    const { selector } = monter({ ruptures: [{ menuItemId: 'poulet', restaurantId: 'kaloum' }] });

    const choix = await selector.choose({
      nearestId: 'kipe',
      position: pres(KIPE),
      menuItemIds: ['poulet', 'jus'],
      orderType: OrderType.DELIVERY,
    });

    expect(choix).toMatchObject({ ok: true, restaurant: { id: 'kipe' }, divertedFrom: null });
  });

  it('bascule chez la plus proche des autres maisons qui a le plat', async () => {
    // Le poulet est épuisé à Kipé. Depuis Kipé, Lambanyi est plus proche
    // que Kaloum : c'est elle qui prépare, et le choix dit pourquoi.
    const { selector } = monter({ ruptures: [{ menuItemId: 'poulet', restaurantId: 'kipe' }] });

    const choix = await selector.choose({
      nearestId: 'kipe',
      position: pres(KIPE),
      menuItemIds: ['poulet', 'jus'],
      orderType: OrderType.DELIVERY,
    });

    expect(choix).toMatchObject({
      ok: true,
      restaurant: { id: 'lambanyi' },
      divertedFrom: { id: 'kipe', name: 'Le Bercail — Kipé', soldOut: [{ id: 'poulet', name: 'Poulet braisé' }] },
    });
  });

  it('saute une maison de secours qui a elle aussi une rupture', async () => {
    // Le poulet manque à Kipé, le jus manque à Lambanyi : seule Kaloum a
    // toute la commande, même si elle est plus loin.
    const { selector } = monter({
      ruptures: [
        { menuItemId: 'poulet', restaurantId: 'kipe' },
        { menuItemId: 'jus', restaurantId: 'lambanyi' },
      ],
    });

    const choix = await selector.choose({
      nearestId: 'kipe',
      position: pres(KIPE),
      menuItemIds: ['poulet', 'jus'],
      orderType: OrderType.DELIVERY,
    });

    expect(choix).toMatchObject({ ok: true, restaurant: { id: 'kaloum' } });
  });

  it('ne confie pas la commande à une maison fermée ni à une qui ne livre pas', async () => {
    const { selector } = monter({
      ruptures: [{ menuItemId: 'poulet', restaurantId: 'kipe' }],
      fermees: ['lambanyi'],
      maisons: [{ ...KALOUM, deliveryEnabled: false }, KIPE, LAMBANYI],
    });

    const livraison = await selector.choose({
      nearestId: 'kipe',
      position: pres(KIPE),
      menuItemIds: ['poulet'],
      orderType: OrderType.DELIVERY,
    });
    // Lambanyi est fermée, Kaloum ne livre pas : personne.
    expect(livraison).toMatchObject({ ok: false, nearest: { id: 'kipe' }, soldOut: [{ id: 'poulet' }] });

    const retrait = await selector.choose({
      nearestId: 'kipe',
      position: pres(KIPE),
      menuItemIds: ['poulet'],
      orderType: OrderType.PICKUP,
    });
    // En retrait, Kaloum convient.
    expect(retrait).toMatchObject({ ok: true, restaurant: { id: 'kaloum' } });
  });

  it('refuse en nommant ce qui manque quand aucune maison ne peut tout préparer', async () => {
    const { selector } = monter({
      ruptures: [
        { menuItemId: 'poulet', restaurantId: 'kipe' },
        { menuItemId: 'poulet', restaurantId: 'kaloum' },
        { menuItemId: 'poulet', restaurantId: 'lambanyi' },
      ],
    });

    await expect(
      selector.chooseOrThrow({
        nearestId: 'kipe',
        position: pres(KIPE),
        menuItemIds: ['poulet', 'jus'],
        orderType: OrderType.DELIVERY,
      }),
    ).rejects.toMatchObject({
      code: 'MENU_ITEM_UNAVAILABLE',
      message: expect.stringContaining('« Poulet braisé » est épuisé chez Le Bercail — Kipé'),
      details: { menuItemIds: ['poulet'], restaurantId: 'kipe' },
    });
  });

  it('part de la maison qui sert la requête quand personne ne désigne la plus proche', async () => {
    // L'aperçu du panier n'a pas encore d'adresse : la maison servie, et
    // les autres classées depuis elle.
    const { selector, settings, router } = monter({
      ruptures: [{ menuItemId: 'poulet', restaurantId: 'kaloum' }],
    });

    const choix = await selector.choose({
      menuItemIds: ['poulet'],
      orderType: OrderType.DELIVERY,
    });

    expect(settings.getRestaurantCached).toHaveBeenCalled();
    expect(router.closestFirst).toHaveBeenCalledWith({ latitude: KALOUM.latitude, longitude: KALOUM.longitude });
    expect(choix).toMatchObject({ ok: true, divertedFrom: { id: 'kaloum' } });
  });
});
