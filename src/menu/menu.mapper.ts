import { Category, MenuItem, MenuItemStockout, MenuOption, MenuOptionGroup } from '@prisma/client';

/**
 * Sérialisation de la carte.
 *
 * La même représentation sert l'application Flutter (consultation) et le
 * back-office React (édition) : un seul contrat, donc aucun risque de
 * divergence entre ce que le client voit et ce que le gestionnaire modifie.
 */

export type CategoryWithCount = Category & { _count?: { menuItems: number } };

export type MenuItemWithRelations = MenuItem & {
  category?: Pick<Category, 'id' | 'name'> | null;
  optionGroups?: (MenuOptionGroup & { options: MenuOption[] })[];
  /** Les maisons où le plat est épuisé. Absent quand la lecture ne l'a pas demandé. */
  stockouts?: (Pick<MenuItemStockout, 'restaurantId'> & { restaurant?: { name: string } | null })[];
};

/** Ce qu'on attend du relevé des ruptures, pour construire une lecture. */
export const STOCKOUTS_INCLUDE = {
  select: { restaurantId: true, restaurant: { select: { name: true } } },
} as const;

/**
 * De quel point de vue lire la disponibilité d'un plat.
 *
 * La carte est commune, la rupture est par maison : « disponible » n'a
 * donc pas le même sens partout.
 *
 *  • `at` — **une maison** : disponible s'il est à la carte et pas épuisé
 *    chez elle. C'est la vue d'un gérant, ou du propriétaire qui a choisi
 *    une adresse ;
 *  • `houses` — **le public** : disponible s'il est à la carte et qu'au
 *    moins une de ces maisons peut le préparer — la commande ira chez
 *    celle-là ;
 *  • ni l'un ni l'autre — **l'enseigne** : le seul interrupteur global,
 *    celui qui retire le plat de toute la carte.
 */
export interface AvailabilityView {
  at?: string | null;
  houses?: readonly string[];
}

function isAvailableFrom(item: MenuItemWithRelations, view: AvailabilityView): boolean {
  if (!item.isAvailable) return false;

  const epuiseChez = new Set((item.stockouts ?? []).map((stockout) => stockout.restaurantId));
  if (view.at) return !epuiseChez.has(view.at);
  if (view.houses && view.houses.length > 0) {
    return view.houses.some((house) => !epuiseChez.has(house));
  }
  return true;
}

export function toCategoryDto(category: CategoryWithCount) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    emoji: category.emoji ?? undefined,
    description: category.description,
    imageUrl: category.imageUrl,
    itemCount: category._count?.menuItems ?? 0,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

export function toMenuOptionDto(option: MenuOption) {
  return {
    id: option.id,
    name: option.name,
    extraPrice: option.extraPrice,
    isAvailable: option.isAvailable,
    sortOrder: option.sortOrder,
  };
}

export function toOptionGroupDto(group: MenuOptionGroup & { options: MenuOption[] }) {
  return {
    id: group.id,
    name: group.name,
    isRequired: group.isRequired,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    sortOrder: group.sortOrder,
    options: [...group.options]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(toMenuOptionDto),
  };
}

export function toMenuItemDto(item: MenuItemWithRelations, view: AvailabilityView = {}) {
  return {
    id: item.id,
    categoryId: item.categoryId,
    categoryName: item.category?.name ?? '',
    name: item.name,
    shortDescription: item.shortDescription,
    description: item.description,
    price: item.price,
    promoPrice: item.promoPrice,
    /** Prix réellement appliqué : le client n'a pas à choisir. */
    effectivePrice: item.promoPrice ?? item.price,
    imageUrl: item.imageUrl,
    ingredients: item.ingredients,
    optionGroups: (item.optionGroups ?? [])
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(toOptionGroupDto),
    isAvailable: isAvailableFrom(item, view),
    /**
     * Où il est épuisé, nommément.
     *
     * Le propriétaire, en vue d'ensemble, voit ainsi « épuisé à Kipé »
     * sur un plat qui reste disponible partout ailleurs — et qu'il ne
     * doit donc pas retirer de la carte.
     */
    soldOutAt: (item.stockouts ?? []).map((stockout) => ({
      restaurantId: stockout.restaurantId,
      restaurantName: stockout.restaurant?.name ?? '',
    })),
    isPopular: item.isPopular,
    isSuggestion: item.isSuggestion,
    isSpicy: item.isSpicy,
    preparationMinutes: item.preparationMinutes,
    rating: item.rating,
    reviewCount: item.reviewCount,
    ordersCount: item.ordersCount,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/** Version allégée pour les listes (le détail des options est inutile). */
export function toMenuItemSummaryDto(item: MenuItemWithRelations, view: AvailabilityView = {}) {
  const dto = toMenuItemDto(item, view);
  return { ...dto, optionGroups: dto.optionGroups.length > 0 ? dto.optionGroups : [] };
}
