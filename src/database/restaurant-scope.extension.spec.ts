import { restaurantContext } from '../common/context/restaurant-context';
import { withRestaurantScope } from './restaurant-scope.extension';

/**
 * Le cloisonnement des données qui n'ont pas d'établissement à elles.
 *
 * Une livraison appartient à sa commande, un livreur à son compte : le
 * filtre doit passer par cette relation. Le 15 septembre 2026, le tableau
 * de bord de Kipé affichait « 1 livraison en cours » pour une course
 * partie de Kaloum, attribuée par Kaloum à un livreur de Kaloum.
 */
describe('Cloisonnement par le parent', () => {
  type Appel = { model?: string; operation: string; args: Record<string, unknown> };

  /** Capture la fonction d'interception et un journal des requêtes finales. */
  function monter() {
    let intercept: ((call: Appel & { query: (a: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) | null = null;
    const client = {
      $extends(ext: { query: { $allModels: { $allOperations: typeof intercept } } }) {
        intercept = ext.query.$allModels.$allOperations;
        return client;
      },
    };
    withRestaurantScope(client);

    const requetes: Record<string, unknown>[] = [];
    const lancer = (appel: Appel) =>
      intercept!({
        ...appel,
        query: async (args) => {
          requetes.push(args);
          return null;
        },
      });

    return { lancer, requetes };
  }

  const chezKipe = <T>(fn: () => Promise<T>) =>
    restaurantContext.run({ restaurantId: 'kipe', unrestricted: false }, fn);

  it('ne compte que les livraisons des commandes de la maison', async () => {
    const { lancer, requetes } = monter();

    await chezKipe(() =>
      lancer({ model: 'Delivery', operation: 'count', args: { where: { status: 'ASSIGNED' } } }),
    );

    expect(requetes[0].where).toEqual({ status: 'ASSIGNED', order: { restaurantId: 'kipe' } });
  });

  it('garde ce que la requête filtrait déjà sur la relation', async () => {
    // La recherche pose `order: { OR: [...] }` : le rattachement s'y ajoute.
    const { lancer, requetes } = monter();

    await chezKipe(() =>
      lancer({
        model: 'Delivery',
        operation: 'findMany',
        args: { where: { order: { OR: [{ reference: { contains: 'BRC' } }] } } },
      }),
    );

    expect(requetes[0].where).toEqual({
      order: { OR: [{ reference: { contains: 'BRC' } }], restaurantId: 'kipe' },
    });
  });

  it('ne liste que les livreurs rattachés à la maison', async () => {
    const { lancer, requetes } = monter();

    await chezKipe(() =>
      lancer({ model: 'DriverProfile', operation: 'findMany', args: { where: { isOnline: true, user: { deletedAt: null } } } }),
    );

    expect(requetes[0].where).toEqual({
      isOnline: true,
      user: { deletedAt: null, restaurantId: 'kipe' },
    });
  });

  it('supporte un comptage sans argument', async () => {
    const { lancer, requetes } = monter();

    await chezKipe(() =>
      lancer({ model: 'DriverProfile', operation: 'count', args: undefined as never }),
    );

    expect(requetes[0].where).toEqual({ user: { restaurantId: 'kipe' } });
  });

  it('laisse passer les lectures par clé unique et les créations', async () => {
    // Une fiche s'ouvre par son identifiant ; le service vérifie ensuite
    // l'établissement lui-même. Une création n'a rien à poser : c'est la
    // commande qui porte la maison.
    const { lancer, requetes } = monter();

    await chezKipe(async () => {
      await lancer({ model: 'Delivery', operation: 'findUnique', args: { where: { id: 'd1' } } });
      await lancer({ model: 'Delivery', operation: 'create', args: { data: { orderId: 'o1' } } });
    });

    expect(requetes[0]).toEqual({ where: { id: 'd1' } });
    expect(requetes[1]).toEqual({ data: { orderId: 'o1' } });
  });

  it('ne filtre rien pour le propriétaire en vue d’ensemble', async () => {
    const { lancer, requetes } = monter();

    await restaurantContext.run({ restaurantId: null, unrestricted: true }, () =>
      lancer({ model: 'Delivery', operation: 'count', args: { where: { status: 'ASSIGNED' } } }),
    );

    expect(requetes[0].where).toEqual({ status: 'ASSIGNED' });
  });
});
