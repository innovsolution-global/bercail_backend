import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RestaurantRouter } from './restaurant-router.service';

/**
 * Où un plat est-il épuisé ?
 *
 * La carte est commune à toutes les maisons ; la rupture ne l'est pas. Un
 * poulet épuisé à Kipé peut encore partir de Kaloum. Deux niveaux
 * coexistent donc, et ne doivent pas se confondre :
 *
 *  • `MenuItem.isAvailable` — le plat est **à la carte**, ou il en est
 *    retiré pour toute l'enseigne. Cela se décide en vue d'ensemble ;
 *  • `MenuItemStockout` — le plat est **épuisé dans une maison**. Son
 *    gérant le déclare, sans rien retirer aux autres.
 *
 * Pour le client, un plat reste commandable tant qu'une maison ouverte au
 * public peut le préparer : la commande part alors chez celle-là. Voir
 * [[KitchenSelector]].
 */
@Injectable()
export class DishAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly router: RestaurantRouter,
  ) {}

  /** Les maisons ouvertes au public — celles où une rupture compte. */
  activeHouses(): Promise<string[]> {
    return this.router.activeIds();
  }

  /**
   * Ceux de ces plats qui sont épuisés dans **cette** maison, nommément.
   *
   * C'est le contrôle de la caisse : quelqu'un devant le comptoir ne peut
   * pas être servi par une autre maison, la commande ne bascule pas.
   */
  async soldOutAt(
    restaurantId: string,
    menuItemIds: readonly string[],
  ): Promise<{ id: string; name: string }[]> {
    if (menuItemIds.length === 0) return [];

    const ruptures = await this.prisma.menuItemStockout.findMany({
      where: { restaurantId, menuItemId: { in: [...new Set(menuItemIds)] } },
      select: { menuItemId: true, menuItem: { select: { name: true } } },
    });

    return ruptures.map((rupture) => ({ id: rupture.menuItemId, name: rupture.menuItem.name }));
  }

  /**
   * Les plats épuisés dans **toutes** les maisons.
   *
   * Ceux-là seuls quittent la carte publique. Tant qu'une maison peut
   * préparer un plat, le client doit pouvoir le commander — c'est la
   * commande qui changera de cuisine, pas la carte qui rétrécira.
   *
   * @param menuItemIds Restreint la recherche à ces plats ; tous sinon.
   */
  async soldOutEverywhere(menuItemIds?: readonly string[]): Promise<string[]> {
    const maisons = await this.router.activeIds();
    if (maisons.length === 0) return [];

    const ruptures = await this.prisma.menuItemStockout.findMany({
      where: {
        restaurantId: { in: maisons },
        ...(menuItemIds ? { menuItemId: { in: [...menuItemIds] } } : {}),
      },
      select: { menuItemId: true },
    });

    // Une ligne par plat et par maison au plus (clé unique) : un plat
    // compté autant de fois qu'il y a de maisons est épuisé partout.
    const parPlat = new Map<string, number>();
    for (const { menuItemId } of ruptures) {
      parPlat.set(menuItemId, (parPlat.get(menuItemId) ?? 0) + 1);
    }

    return [...parPlat]
      .filter(([, maisonsEpuisees]) => maisonsEpuisees >= maisons.length)
      .map(([menuItemId]) => menuItemId);
  }
}
