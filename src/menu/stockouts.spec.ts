import type { AuditService } from '../audit/audit.service';
import { DishAvailabilityService } from '../common/context/dish-availability.service';
import { restaurantContext } from '../common/context/restaurant-context';
import type { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { MenuItemsService } from './menu-items.service';
import { toMenuItemDto } from './menu.mapper';

/**
 * La rupture est propre à chaque maison.
 *
 * La carte est commune ; un gérant qui marque un plat « épuisé » ne le
 * fait que chez lui. Le propriétaire, en vue d'ensemble, garde le seul
 * interrupteur qui retire un plat de toute la carte.
 */
describe('Ruptures par maison', () => {
  const acteur = { id: 'u1', role: 'ADMIN' } as never;
  const contexte = {} as never;

  function monter(plat: { isAvailable?: boolean; stockouts?: { restaurantId: string }[] } = {}) {
    const existant = {
      id: 'plat-1',
      name: 'Poulet braisé',
      isAvailable: plat.isAvailable ?? true,
      stockouts: (plat.stockouts ?? []).map((s) => ({ ...s, restaurant: { name: s.restaurantId } })),
      category: { id: 'c', name: 'Grillades' },
      optionGroups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const prisma = {
      menuItem: {
        findFirst: jest.fn(async () => existant),
        findUniqueOrThrow: jest.fn(async () => existant),
        update: jest.fn(async () => existant),
      },
      menuItemStockout: {
        upsert: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const redis = { delByPattern: jest.fn(async () => undefined) };
    const audit = { record: jest.fn(async () => undefined) };

    const service = new MenuItemsService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      audit as unknown as AuditService,
      { get: () => 300 } as never,
      {} as RestaurantScopeService,
      { activeHouses: jest.fn(async () => ['kaloum', 'kipe']) } as never,
    );

    return { service, prisma, audit };
  }

  const chezKipe = <T>(fn: () => Promise<T>) =>
    restaurantContext.run({ restaurantId: 'kipe', unrestricted: false }, fn);

  it('marque le plat épuisé dans la maison du gérant, et nulle part ailleurs', async () => {
    const { service, prisma } = monter();

    await chezKipe(() => service.setAvailability('plat-1', false, acteur, contexte));

    expect(prisma.menuItemStockout.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { menuItemId: 'plat-1', restaurantId: 'kipe' } }),
    );
    // L'interrupteur de l'enseigne n'a pas bougé.
    expect(prisma.menuItem.update).not.toHaveBeenCalled();
  });

  it('lève la rupture de sa maison seulement', async () => {
    const { service, prisma } = monter({ stockouts: [{ restaurantId: 'kipe' }, { restaurantId: 'kaloum' }] });

    await chezKipe(() => service.setAvailability('plat-1', true, acteur, contexte));

    expect(prisma.menuItemStockout.deleteMany).toHaveBeenCalledWith({
      where: { menuItemId: 'plat-1', restaurantId: 'kipe' },
    });
  });

  it('ne laisse pas une maison remettre à la carte un plat que l’enseigne a retiré', async () => {
    const { service, prisma } = monter({ isAvailable: false });

    await expect(
      chezKipe(() => service.setAvailability('plat-1', true, acteur, contexte)),
    ).rejects.toThrow(/retiré de la carte pour toute l’enseigne/);

    expect(prisma.menuItemStockout.deleteMany).not.toHaveBeenCalled();
  });

  it('retire le plat de toute la carte depuis la vue d’ensemble', async () => {
    const { service, prisma, audit } = monter();

    await restaurantContext.run({ restaurantId: null, unrestricted: true }, () =>
      service.setAvailability('plat-1', false, acteur, contexte),
    );

    expect(prisma.menuItem.update).toHaveBeenCalledWith({
      where: { id: 'plat-1' },
      data: { isAvailable: false },
    });
    expect(prisma.menuItemStockout.upsert).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MENU_ITEM_AVAILABILITY' }),
    );
  });

  describe('lecture', () => {
    const plat = {
      id: 'plat-1',
      name: 'Poulet braisé',
      isAvailable: true,
      stockouts: [{ restaurantId: 'kipe', restaurant: { name: 'Le Bercail — Kipé' } }],
      category: { id: 'c', name: 'Grillades' },
      optionGroups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never;

    it('se lit épuisé dans sa maison, disponible dans une autre', () => {
      expect(toMenuItemDto(plat, { at: 'kipe' }).isAvailable).toBe(false);
      expect(toMenuItemDto(plat, { at: 'kaloum' }).isAvailable).toBe(true);
    });

    it('reste disponible pour le public tant qu’une maison peut le préparer', () => {
      expect(toMenuItemDto(plat, { houses: ['kaloum', 'kipe'] }).isAvailable).toBe(true);
      expect(toMenuItemDto(plat, { houses: ['kipe'] }).isAvailable).toBe(false);
    });

    it('nomme les maisons où il est épuisé, pour la vue d’ensemble', () => {
      const dto = toMenuItemDto(plat);
      expect(dto.isAvailable).toBe(true);
      expect(dto.soldOutAt).toEqual([{ restaurantId: 'kipe', restaurantName: 'Le Bercail — Kipé' }]);
    });
  });

  describe('épuisé partout', () => {
    function monterRuptures(ruptures: { menuItemId: string; restaurantId: string }[]) {
      const prisma = {
        menuItemStockout: { findMany: jest.fn(async () => ruptures) },
      };
      const router = { activeIds: jest.fn(async () => ['kaloum', 'kipe']) };
      return new DishAvailabilityService(prisma as never, router as never);
    }

    it('ne compte que les plats épuisés dans toutes les maisons ouvertes', async () => {
      const service = monterRuptures([
        { menuItemId: 'poulet', restaurantId: 'kipe' },
        { menuItemId: 'jus', restaurantId: 'kipe' },
        { menuItemId: 'jus', restaurantId: 'kaloum' },
      ]);

      expect(await service.soldOutEverywhere()).toEqual(['jus']);
    });
  });
});
