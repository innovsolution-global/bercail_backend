import type { PrismaService } from '../../database/prisma.service';
import { restaurantContext, type RestaurantScope } from './restaurant-context';
import type { RestaurantRouter } from './restaurant-router.service';
import { RestaurantScopeService } from './restaurant-scope.service';

/**
 * Quelle maison répond à une lecture publique.
 *
 * Le défaut corrigé ici se voyait à l'écran sans pouvoir s'expliquer : un
 * client choisissait son adresse de Kipé, lisait « Kipé » sous l'épingle de
 * l'accueil — et recevait la carte de Kaloum, parce que le serveur ne
 * connaissait que l'adresse **par défaut** de son carnet. Il remplissait
 * son panier, puis se faisait refuser la commande.
 *
 * L'ordre de confiance est désormais figé : ce que l'application désigne,
 * puis le carnet, puis la maison la plus ancienne.
 */
describe('Maison servie : ordre des sources', () => {
  const KIPE = { latitude: 9.639, longitude: -13.622 };

  function monter(options: {
    proche?: string | null;
    duCarnet?: string | null;
    routeurEnPanne?: boolean;
  } = {}) {
    const router = {
      nearestTo: jest.fn(async () => {
        if (options.routeurEnPanne) throw new Error('base indisponible');
        return options.proche ?? null;
      }),
      forCustomer: jest.fn(async () => options.duCarnet ?? null),
    };
    const prisma = {
      restaurant: { findFirst: jest.fn(async () => ({ id: 'ancienne' })) },
    };

    return {
      service: new RestaurantScopeService(
        prisma as unknown as PrismaService,
        router as unknown as RestaurantRouter,
      ),
      router,
    };
  }

  const dans = <T>(scope: RestaurantScope, fn: () => Promise<T>) =>
    restaurantContext.run(scope, fn);

  it('suit la position désignée par l’application avant le carnet', async () => {
    const { service, router } = monter({ proche: 'kipe', duCarnet: 'kaloum' });

    const id = await dans(
      { restaurantId: null, unrestricted: true, customerId: 'u1', position: KIPE },
      () => service.publicRestaurantId(),
    );

    expect(id).toBe('kipe');
    // Le carnet n'a même pas à être lu : la source la plus sûre a répondu.
    expect(router.forCustomer).not.toHaveBeenCalled();
  });

  it('retombe sur le carnet quand l’application ne dit rien', async () => {
    const { service, router } = monter({ duCarnet: 'kaloum' });

    const id = await dans(
      { restaurantId: null, unrestricted: true, customerId: 'u1' },
      () => service.publicRestaurantId(),
    );

    expect(id).toBe('kaloum');
    expect(router.nearestTo).not.toHaveBeenCalled();
  });

  it('retombe sur le carnet quand la position ne désigne aucune maison', async () => {
    // Aucune maison localisée : le point ne tranche rien, il ne doit pas
    // pour autant court-circuiter l'adresse du client.
    const { service } = monter({ proche: null, duCarnet: 'kaloum' });

    const id = await dans(
      { restaurantId: null, unrestricted: true, customerId: 'u1', position: KIPE },
      () => service.publicRestaurantId(),
    );

    expect(id).toBe('kaloum');
  });

  it('sert un visiteur anonyme selon sa position', async () => {
    // Pas encore de compte, debout à Kipé : il doit voir la carte de Kipé,
    // pas celle de la maison la plus ancienne.
    const { service } = monter({ proche: 'kipe' });

    const id = await dans(
      { restaurantId: null, unrestricted: true, position: KIPE },
      () => service.publicRestaurantId(),
    );

    expect(id).toBe('kipe');
  });

  it('retombe sur la maison la plus ancienne quand rien ne situe le client', async () => {
    const { service } = monter();

    const avecContexte = await dans(
      { restaurantId: null, unrestricted: true, customerId: 'u1' },
      () => service.publicRestaurantId(),
    );
    const sansContexte = await service.publicRestaurantId();

    expect(avecContexte).toBe('ancienne');
    expect(sansContexte).toBe('ancienne');
  });

  it('ne casse pas la carte quand le routage échoue', async () => {
    const { service } = monter({ routeurEnPanne: true });

    const id = await dans(
      { restaurantId: null, unrestricted: true, position: KIPE },
      () => service.publicRestaurantId(),
    );

    expect(id).toBe('ancienne');
  });

  it('résout une seule fois par requête', async () => {
    // La fiche, la carte et les promotions partent en parallèle : elles
    // doivent parler de la même maison, sans la chercher trois fois.
    const { service, router } = monter({ proche: 'kipe' });

    const ids = await dans(
      { restaurantId: null, unrestricted: true, position: KIPE },
      () =>
        Promise.all([
          service.publicRestaurantId(),
          service.publicRestaurantId(),
          service.publicRestaurantId(),
        ]),
    );

    expect(ids).toEqual(['kipe', 'kipe', 'kipe']);
    expect(router.nearestTo).toHaveBeenCalledTimes(1);
  });
});
