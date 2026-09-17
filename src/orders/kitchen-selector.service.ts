import { Injectable, Logger } from '@nestjs/common';
import { OrderType } from '@prisma/client';
import { RestaurantRouter } from '../common/context/restaurant-router.service';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { isValidCoordinates, type Coordinates } from '../common/utils/geo.util';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';

type Maison = Awaited<ReturnType<SettingsService['byId']>>;

export interface SoldOutDish {
  id: string;
  name: string;
}

export type KitchenChoice =
  | {
      ok: true;
      /** La maison qui prépare : ses frais, son minimum, ses horaires. */
      restaurant: Maison;
      /** La maison la plus proche, quand des ruptures l'ont fait passer la main. */
      divertedFrom: { id: string; name: string; soldOut: SoldOutDish[] } | null;
    }
  | {
      ok: false;
      /** La maison qui aurait dû préparer. */
      nearest: Maison;
      /** Ce qui y manque — et qu'aucune autre maison ouverte n'a pu compenser. */
      soldOut: SoldOutDish[];
    };

export interface KitchenRequest {
  /** La maison la plus proche de l'adresse livrée ; celle qui sert la requête sinon. */
  nearestId?: string | null;
  /** D'où classer les autres maisons ; la maison la plus proche sinon. */
  position?: Coordinates | null;
  menuItemIds: readonly string[];
  orderType: OrderType;
}

/** « Poulet braisé » est épuisé — ou « … sont épuisés » pour plusieurs plats. */
export function describeSoldOut(dishes: readonly SoldOutDish[]): string {
  const noms = dishes.map((dish) => `« ${dish.name} »`).join(', ');
  return `${noms} ${dishes.length > 1 ? 'sont épuisés' : 'est épuisé'}`;
}

/**
 * Quelle cuisine prépare une commande.
 *
 * D'abord **la maison la plus proche** : c'est de là que le repas arrive
 * chaud. Mais la rupture est propre à chaque maison — un gérant qui marque
 * un plat « épuisé » ne le fait que chez lui. Si la plus proche n'a plus
 * l'un des plats commandés, la commande **bascule** chez la plus proche des
 * autres qui a tout, qui est ouverte et qui assure ce mode de service
 * (livraison ou retrait). Personne n'a à refaire son panier.
 *
 * La bascule ne se déclenche que sur une rupture. Une maison la plus
 * proche simplement fermée reste un refus « restaurant fermé », comme
 * avant : l'envoyer à l'autre bout de la ville n'a pas été décidé.
 *
 * Quand aucune maison ne peut préparer toute la commande — un plat épuisé
 * ici, un autre là-bas —, le résultat le dit, avec ce qui manque chez la
 * plus proche : c'est ce que le client doit retirer.
 */
@Injectable()
export class KitchenSelector {
  private readonly logger = new Logger(KitchenSelector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly router: RestaurantRouter,
  ) {}

  async choose(request: KitchenRequest): Promise<KitchenChoice> {
    const nearest = request.nearestId
      ? await this.settings.byId(request.nearestId)
      : await this.settings.getRestaurantCached();

    const plats = [...new Set(request.menuItemIds)];
    const ruptures =
      plats.length === 0
        ? []
        : await this.prisma.menuItemStockout.findMany({
            where: { menuItemId: { in: plats } },
            select: { menuItemId: true, restaurantId: true, menuItem: { select: { name: true } } },
          });

    const epuisesChez = (restaurantId: string) =>
      ruptures.filter((rupture) => rupture.restaurantId === restaurantId);

    const manquants = epuisesChez(nearest.id).map((rupture) => ({
      id: rupture.menuItemId,
      name: rupture.menuItem.name,
    }));

    if (manquants.length === 0) {
      return { ok: true, restaurant: nearest, divertedFrom: null };
    }

    // Les autres maisons, de la plus proche à la plus lointaine du repas.
    const point = isValidCoordinates(request.position)
      ? request.position
      : { latitude: nearest.latitude, longitude: nearest.longitude };

    for (const id of await this.router.closestFirst(point)) {
      if (id === nearest.id || epuisesChez(id).length > 0) continue;

      const maison = await this.settings.byId(id).catch(() => null);
      if (!maison || !this.canTake(maison, request.orderType)) continue;

      this.logger.log(
        `Commande confiée à ${maison.name} : ${describeSoldOut(manquants)} chez ${nearest.name}.`,
      );

      return {
        ok: true,
        restaurant: maison,
        divertedFrom: { id: nearest.id, name: nearest.name, soldOut: manquants },
      };
    }

    return { ok: false, nearest, soldOut: manquants };
  }

  /** Comme [[choose]], mais refuse quand aucune maison ne peut tout préparer. */
  async chooseOrThrow(request: KitchenRequest): Promise<Extract<KitchenChoice, { ok: true }>> {
    const choice = await this.choose(request);
    if (choice.ok) return choice;

    const retirer = choice.soldOut.length > 1 ? 'Retirez-les' : 'Retirez-le';
    throw AppException.conflict(
      ERROR_CODES.MENU_ITEM_UNAVAILABLE,
      `${describeSoldOut(choice.soldOut)} chez ${choice.nearest.name}, et aucune autre de nos maisons ouvertes ne peut préparer toute la commande. ${retirer} du panier pour continuer.`,
      {
        menuItemIds: choice.soldOut.map((dish) => dish.id),
        restaurantId: choice.nearest.id,
      },
    );
  }

  /** Ouverte maintenant, et elle assure ce mode de service. */
  private canTake(maison: Maison, orderType: OrderType): boolean {
    if (!this.settings.isOpenNow(maison)) return false;
    return orderType === OrderType.PICKUP ? maison.pickupEnabled : maison.deliveryEnabled;
  }
}
