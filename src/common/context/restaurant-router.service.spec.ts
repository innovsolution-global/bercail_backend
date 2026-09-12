import type { PrismaService } from '../../database/prisma.service';
import { RestaurantRouter } from './restaurant-router.service';

/**
 * Quel établissement sert quel client.
 *
 * Le défaut corrigé ici n'était pas visible à l'écran : **toutes** les
 * commandes partaient au même établissement — le plus ancien — quelle
 * que soit la position du client, et l'alerte « nouvelle commande » était
 * envoyée à tous les gérants de l'enseigne. Deux cuisines pouvaient donc
 * préparer le même plat, et deux livreurs partir pour la même porte.
 */
describe('Routage des clients vers l’établissement le plus proche', () => {
  // Deux vraies adresses de l'enseigne, à une vingtaine de kilomètres.
  const KALOUM = { id: 'kaloum', latitude: 9.509167, longitude: -13.712222 };
  const KIPE = { id: 'kipe', latitude: 9.639167, longitude: -13.622222 };

  function monter(
    maisons: { id: string; latitude: number; longitude: number }[] = [KALOUM, KIPE],
    adresses: { latitude: number | null; longitude: number | null; isDefault: boolean }[] = [],
  ) {
    const prisma = {
      restaurant: {
        findMany: jest.fn(async () =>
          maisons.map((m) => ({ ...m, createdAt: new Date() })),
        ),
      },
      address: {
        findMany: jest.fn(async () => adresses.slice(0, 1)),
      },
      menuItem: {
        findMany: jest.fn(async () => []),
      },
    };

    return {
      router: new RestaurantRouter(prisma as unknown as PrismaService),
      prisma,
    };
  }

  it('sert la maison la plus proche du point donné', async () => {
    const { router } = monter();

    // Un client de Ratoma, à deux pas de Kipé.
    expect(await router.nearestTo({ latitude: 9.63, longitude: -13.62 })).toBe('kipe');

    // Un client de la presqu'île, à Kaloum.
    expect(await router.nearestTo({ latitude: 9.51, longitude: -13.71 })).toBe('kaloum');
  });

  it('suit l’adresse par défaut du client', async () => {
    // C'est celle que l'application propose au paiement : c'est donc là
    // que le repas ira le plus souvent, et de là qu'il doit partir.
    const { router } = monter(
      [KALOUM, KIPE],
      [{ latitude: 9.64, longitude: -13.62, isDefault: true }],
    );

    expect(await router.forCustomer('u1')).toBe('kipe');
  });

  it('ne désigne personne quand le client n’est pas situable', async () => {
    // Aucune adresse, ou aucune adresse localisée : l'appelant retombe
    // alors sur la maison la plus ancienne plutôt que d'en tirer une au
    // sort — ce qui enverrait le repas n'importe où.
    const { router } = monter([KALOUM, KIPE], []);

    expect(await router.forCustomer('u1')).toBeNull();
  });

  it('ignore les maisons sans coordonnées', async () => {
    const { router } = monter([
      { id: 'sans-point', latitude: 0, longitude: 0 },
      KIPE,
    ]);

    // (0, 0) est en plein golfe de Guinée : une maison mal renseignée ne
    // doit pas rafler les clients par la seule vertu d'un zéro.
    expect(await router.nearestTo({ latitude: 9.63, longitude: -13.62 })).toBe('kipe');
  });

  it('ne relit pas la liste des maisons à chaque appel', async () => {
    // Elle est consultée à chaque lecture publique : une requête par
    // appel pour une table de trois lignes serait du gaspillage.
    const { router, prisma } = monter();

    await router.nearestTo({ latitude: 9.63, longitude: -13.62 });
    await router.nearestTo({ latitude: 9.51, longitude: -13.71 });
    await router.oldest();

    expect(prisma.restaurant.findMany).toHaveBeenCalledTimes(1);
  });

  it('rend les maisons d’où viennent les plats d’un panier', async () => {
    // C'est ce qui décide de la cuisine : un plat appartient à une carte,
    // une carte à une maison. Deux maisons dans un panier, et la commande
    // est refusée plutôt que répartie au hasard.
    const { router, prisma } = monter();
    prisma.menuItem.findMany = jest.fn(async () => [
      { restaurantId: 'kipe' },
      { restaurantId: 'kipe' },
    ]) as never;

    expect(await router.forMenuItems(['p1', 'p2'])).toEqual(['kipe']);
  });
});
