import type { AuditService } from '../audit/audit.service';
import type { DishAvailabilityService } from '../common/context/dish-availability.service';
import type { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { CategoriesService } from './categories.service';
import type { MenuItemQueryDto } from './dto/menu.dto';
import { MenuItemsService } from './menu-items.service';

/**
 * La carte est commune à toutes les maisons.
 *
 * Décision du propriétaire, le 14 septembre 2026 : l'enseigne tient une
 * seule carte — catégories, plats, promotions — que chaque maison sert.
 * Ce qui reste propre à chaque maison, ce sont ses frais, ses horaires,
 * son stock et ses comptes.
 *
 * Ces tests gardent la règle inverse de celle d'avant : aucune lecture de
 * carte ne doit plus poser de filtre d'établissement, et le client comme
 * le back-office partagent la même réponse en cache. Un filtre qui
 * reviendrait par mégarde viderait la carte d'une maison sans bruit.
 */
describe('Carte commune', () => {
  interface Espion {
    categories: CategoriesService;
    plats: MenuItemsService;
    filtres: Record<string, unknown>[];
    cles: string[];
    scope: { publicRestaurantId: jest.Mock };
    ruptures: { soldOutEverywhere: jest.Mock; activeHouses: jest.Mock };
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
      remember: jest.fn(async <T>(cle: string, _ttl: number, charger: () => Promise<T>) => {
        cles.push(cle);
        return charger();
      }),
      delByPattern: jest.fn(),
    };

    const scope = { publicRestaurantId: jest.fn(async () => 'restaurant-kaloum') };
    const ruptures = {
      soldOutEverywhere: jest.fn(async () => [] as string[]),
      activeHouses: jest.fn(async () => ['restaurant-kaloum', 'restaurant-kipe']),
    };

    const commun = [
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      { record: jest.fn() } as unknown as AuditService,
      { get: () => 300 } as never,
      scope as unknown as RestaurantScopeService,
    ] as const;

    return {
      categories: new CategoriesService(...commun),
      plats: new MenuItemsService(...commun, ruptures as unknown as DishAvailabilityService),
      filtres,
      cles,
      scope,
      ruptures,
    };
  }

  const requete = (extra: Partial<MenuItemQueryDto> = {}) =>
    ({ page: 1, limit: 20, skip: 0, take: 20, ...extra }) as MenuItemQueryDto;

  it('sert les mêmes catégories à toutes les maisons', async () => {
    const e = monter();
    await e.categories.list(false, true);

    expect(e.filtres[0].restaurantId).toBeUndefined();
    // Plus besoin de savoir qui sert le client pour lire la carte.
    expect(e.scope.publicRestaurantId).not.toHaveBeenCalled();
  });

  it('partage une seule réponse en cache entre client et back-office', async () => {
    const e = monter();
    await e.categories.list(false, true);
    await e.categories.list(false, false);

    expect(e.cles[0]).toBe(e.cles[1]);
  });

  it('sert les mêmes plats à toutes les maisons', async () => {
    const e = monter();
    await e.plats.list(requete(), { publicOnly: true });

    expect(e.filtres[0].restaurantId).toBeUndefined();
    // La carte publique garde en revanche ses deux gardes : disponible,
    // et rangé dans une catégorie active.
    expect(e.filtres[0].isAvailable).toBe(true);
  });

  it('ne retire de la carte publique que les plats épuisés partout', async () => {
    // Épuisé à Kipé seulement, le poulet reste sur la carte : la
    // commande partira de Kaloum. Le jus, épuisé partout, en sort.
    const e = monter();
    e.ruptures.soldOutEverywhere.mockResolvedValue(['plat-jus']);

    await e.plats.list(requete(), { publicOnly: true });

    expect(e.filtres[0].id).toEqual({ notIn: ['plat-jus'] });
  });

  it('trouve une catégorie par slug pour toute l’enseigne', async () => {
    // Une seule « grillades » depuis que la carte est commune : le slug
    // suffit, sans maison pour le départager.
    const e = monter();
    await e.plats.list(requete({ categoryId: 'grillades' }), { publicOnly: true });

    const parSlug = e.filtres.find((f) => Array.isArray(f.OR));
    expect(parSlug).toBeDefined();
    expect(parSlug?.restaurantId).toBeUndefined();
  });

  it('ouvre la fiche d’un plat sans filtre de maison', async () => {
    const e = monter();
    await expect(e.plats.findOne('plat-1', { publicOnly: true })).rejects.toThrow();

    expect(e.filtres[0].restaurantId).toBeUndefined();
  });
});
