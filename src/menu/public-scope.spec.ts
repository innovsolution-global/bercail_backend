import type { AuditService } from '../audit/audit.service';
import type { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { CategoriesService } from './categories.service';
import type { MenuItemQueryDto } from './dto/menu.dto';
import { MenuItemsService } from './menu-items.service';

/**
 * La carte servie au client ne mélange pas les établissements.
 *
 * Ce défaut est resté invisible tant qu'il n'y avait qu'une maison :
 * rien ne cloisonnait la carte publique, mais il n'y avait qu'un
 * catalogue, donc rien à mélanger. À l'ouverture du second
 * établissement, l'accueil de l'application s'est mis à afficher deux
 * fois « Grillades » et deux fois « Poissons » — une paire par maison,
 * avec les frais de livraison de l'autre.
 *
 * Un client n'appartient à aucun établissement, donc le cloisonnement
 * automatique du client Prisma ne s'applique pas à lui : ces lectures-là
 * doivent poser le filtre elles-mêmes. C'est exactement ce qu'un
 * refactoring peut défaire sans que rien ne se voie, d'où ces tests.
 */
describe('Carte publique', () => {
  const MAISON = 'restaurant-kaloum';

  /** Les filtres réellement envoyés à Prisma, et les clés de cache. */
  interface Espion {
    categories: CategoriesService;
    plats: MenuItemsService;
    filtres: Record<string, unknown>[];
    cles: string[];
  }

  function monter(): Espion {
    const filtres: Record<string, unknown>[] = [];
    const cles: string[] = [];

    const retenir = (args: { where?: Record<string, unknown> }) => {
      filtres.push(args.where ?? {});
    };

    const prisma = {
      category: {
        findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
          retenir(args);
          return [];
        }),
        findFirst: jest.fn(async (args: { where?: Record<string, unknown> }) => {
          retenir(args);
          return { id: 'cat-1' };
        }),
      },
      menuItem: {
        findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
          retenir(args);
          return [];
        }),
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async (args: { where?: Record<string, unknown> }) => {
          retenir(args);
          return null;
        }),
      },
    };

    const redis = {
      // Le cache ne masque rien : on exécute toujours la lecture, mais
      // on garde la clé — c'est elle qui dit si deux publics partagent
      // la même réponse.
      remember: jest.fn(async <T>(cle: string, _ttl: number, charger: () => Promise<T>) => {
        cles.push(cle);
        return charger();
      }),
      delByPattern: jest.fn(),
    };

    const scope = { publicRestaurantId: jest.fn(async () => MAISON) };

    const commun = [
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      { record: jest.fn() } as unknown as AuditService,
      { get: () => 300 } as never,
      scope as unknown as RestaurantScopeService,
    ] as const;

    return {
      categories: new CategoriesService(...commun),
      plats: new MenuItemsService(...commun),
      filtres,
      cles,
    };
  }

  const requete = (extra: Partial<MenuItemQueryDto> = {}) =>
    ({ page: 1, limit: 20, skip: 0, take: 20, ...extra }) as MenuItemQueryDto;

  it('ramène les catégories du client à la maison qu’il consulte', async () => {
    const e = monter();
    await e.categories.list(false, true);

    expect(e.filtres[0].restaurantId).toBe(MAISON);
  });

  it('laisse le back-office à son propre cloisonnement', async () => {
    // Un ADMIN est déjà borné à son établissement par le client Prisma,
    // et le propriétaire les voit tous : leur imposer ici la maison du
    // public priverait l'un de sa carte et l'autre de sa vue d'ensemble.
    const e = monter();
    await e.categories.list(false, false);

    expect(e.filtres[0].restaurantId).toBeUndefined();
  });

  it('ne sert pas la même réponse en cache aux deux publics', async () => {
    const e = monter();
    await e.categories.list(false, true);
    await e.categories.list(false, false);

    expect(e.cles[0]).not.toBe(e.cles[1]);
  });

  it('ramène les plats du client à la même maison', async () => {
    const e = monter();
    await e.plats.list(requete(), { publicOnly: true });

    expect(e.filtres[0].restaurantId).toBe(MAISON);
  });

  it('cherche une catégorie par slug dans cette maison, pas ailleurs', async () => {
    // « grillades » existe dans les deux établissements : sans ce
    // filtre, ouvrir la catégorie depuis l'accueil pouvait afficher les
    // grillades de l'autre maison.
    const e = monter();
    await e.plats.list(requete({ categoryId: 'grillades' }), { publicOnly: true });

    const parSlug = e.filtres.find((f) => Array.isArray(f.OR));
    expect(parSlug?.restaurantId).toBe(MAISON);
  });

  it('refuse la fiche d’un plat d’une autre maison', async () => {
    const e = monter();
    await expect(e.plats.findOne('plat-de-kipe', { publicOnly: true })).rejects.toThrow();

    expect(e.filtres[0].restaurantId).toBe(MAISON);
  });
});
