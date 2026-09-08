import { Category, MenuItem, MenuOption, MenuOptionGroup } from '@prisma/client';

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
};

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

export function toMenuItemDto(item: MenuItemWithRelations) {
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
    isAvailable: item.isAvailable,
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
export function toMenuItemSummaryDto(item: MenuItemWithRelations) {
  const dto = toMenuItemDto(item);
  return { ...dto, optionGroups: dto.optionGroups.length > 0 ? dto.optionGroups : [] };
}
