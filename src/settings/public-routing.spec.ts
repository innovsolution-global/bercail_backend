import { restaurantContext } from '../common/context/restaurant-context';
import { RestaurantRouter } from '../common/context/restaurant-router.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import type { PrismaService } from '../database/prisma.service';

/**
 * La carte servie au client suit sa position.
 *
 * C'est le point d'entrée de tout le reste : la maison qui sert la carte
 * est celle dont le client voit les prix, celle dont les plats entrent
 * dans son panier, et donc celle dont la cuisine recevra sa commande.
 * Tant que c'était la **plus ancienne**, quelqu'un habitant à côté de
 * Kipé commandait à Kaloum, à vingt kilomètres, et son plat partait de
 * là-bas.
 */
describe('L’établissement servi au client', () => {
  const KALOUM = { id: 'kaloum', latitude: 9.509167, longitude: -13.712222 };
  const KIPE = { id: 'kipe', latitude: 9.639167, longitude: -13.622222 };

  function monter(adresses: { latitude: number; longitude: number; isDefault: boolean }[]) {
    const prisma = {
      restaurant: {
        findMany: jest.fn(async () =>
          [KALOUM, KIPE].map((m) => ({ ...m, createdAt: new Date() })),
        ),
        // Le repli : la plus ancienne, c'est-à-dire Kaloum.
        findFirst: jest.fn(async () => ({ id: KALOUM.id })),
      },
      address: { findMany: jest.fn(async () => adresses.slice(0, 1)) },
    };

    const scope = new RestaurantScopeService(
      prisma as unknown as PrismaService,
      new RestaurantRouter(prisma as unknown as PrismaService),
    );

    return { scope, prisma };
  }

  it('sert la maison la plus proche de l’adresse du client', async () => {
    const { scope } = monter([{ latitude: 9.64, longitude: -13.62, isDefault: true }]);

    const servie = await restaurantContext.run(
      { restaurantId: null, unrestricted: true, customerId: 'u1' },
      () => scope.publicRestaurantId(),
    );

    expect(servie).toBe('kipe');
  });

  it('retombe sur la plus ancienne quand le client n’est pas situable', async () => {
    // Un compte tout neuf, sans adresse : il faut bien lui servir une
    // carte. La plus ancienne est un choix arbitraire, mais stable — et
    // le formulaire d'adresse propose la position pour en sortir.
    const { scope } = monter([]);

    const servie = await restaurantContext.run(
      { restaurantId: null, unrestricted: true, customerId: 'u1' },
      () => scope.publicRestaurantId(),
    );

    expect(servie).toBe('kaloum');
  });

  it('ne cherche la maison qu’une fois par requête', async () => {
    // Une requête déclenche plusieurs lectures publiques — la carte, la
    // fiche, les promotions — et toutes doivent parler de la **même**
    // maison, sans la rechercher à chaque fois.
    const { scope, prisma } = monter([
      { latitude: 9.64, longitude: -13.62, isDefault: true },
    ]);

    await restaurantContext.run(
      { restaurantId: null, unrestricted: true, customerId: 'u1' },
      async () => {
        await Promise.all([
          scope.publicRestaurantId(),
          scope.publicRestaurantId(),
          scope.publicRestaurantId(),
        ]);
      },
    );

    expect(prisma.address.findMany).toHaveBeenCalledTimes(1);
  });

  it('sert la plus ancienne à une visite anonyme', async () => {
    // Hors requête authentifiée, il n'y a personne à situer.
    const { scope } = monter([{ latitude: 9.64, longitude: -13.62, isDefault: true }]);

    expect(await scope.publicRestaurantId()).toBe('kaloum');
  });
});
