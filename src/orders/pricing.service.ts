import { Injectable } from '@nestjs/common';
import { OrderType, Prisma, PromotionType } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { capDiscount, clampToZero, percentageOf } from '../common/utils/money.util';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';

export interface PricedLineOption {
  optionId: string;
  groupName: string;
  optionName: string;
  extraPrice: number;
}

export interface PricedLine {
  menuItemId: string;
  name: string;
  imageUrl: string | null;
  /** Prix catalogue appliqué (promotionnel si défini). */
  unitPrice: number;
  quantity: number;
  note?: string | null;
  options: PricedLineOption[];
  /** (prix unitaire + suppléments) × quantité */
  lineTotal: number;
}

export interface PriceQuote {
  lines: PricedLine[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  promotion: { id: string; code: string; type: string; label: string } | null;
  currency: string;
  minimumOrder: number;
  freeDeliveryThreshold: number | null;
  estimatedPreparationMinutes: number;
}

export interface LineInput {
  menuItemId: string;
  quantity: number;
  optionIds?: string[];
  note?: string | null;
}

export interface QuoteInput {
  lines: LineInput[];
  orderType: OrderType;
  promotionCode?: string | null;
  customerId?: string;
}

/**
 * Moteur de prix — autorité unique sur les montants.
 *
 * Règle non négociable : ni Flutter ni React n'envoient de montant. Ils
 * envoient des identifiants de plats, des options et des quantités ; le
 * serveur relit les prix en base et recalcule tout. Un `total` reçu du
 * client serait ignoré — ici, il n'est même pas accepté dans le DTO.
 *
 * Le même moteur sert l'aperçu du panier et la création de commande :
 * le prix affiché avant paiement est celui qui sera facturé.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async quote(input: QuoteInput, client: Prisma.TransactionClient = this.prisma): Promise<PriceQuote> {
    if (input.lines.length === 0) {
      throw AppException.badRequest(ERROR_CODES.CART_EMPTY, 'Votre panier est vide.');
    }

    const restaurant = await this.settings.getRestaurantCached();

    const menuItemIds = [...new Set(input.lines.map((line) => line.menuItemId))];
    const items = await client.menuItem.findMany({
      where: { id: { in: menuItemIds }, deletedAt: null },
      include: { optionGroups: { include: { options: true } } },
    });

    const itemById = new Map(items.map((item) => [item.id, item]));
    const lines: PricedLine[] = [];

    for (const line of input.lines) {
      const item = itemById.get(line.menuItemId);

      if (!item) {
        throw AppException.conflict(
          ERROR_CODES.MENU_ITEM_UNAVAILABLE,
          "Un plat de votre panier n'existe plus.",
          { menuItemId: line.menuItemId },
        );
      }

      if (!item.isAvailable) {
        throw AppException.conflict(
          ERROR_CODES.MENU_ITEM_UNAVAILABLE,
          `« ${item.name} » n'est plus disponible.`,
          { menuItemId: item.id },
        );
      }

      if (line.quantity < 1 || line.quantity > 50) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'La quantité doit être comprise entre 1 et 50.',
        );
      }

      const selectedOptions = this.resolveOptions(item, line.optionIds ?? []);
      const unitPrice = item.promoPrice ?? item.price;
      const extras = selectedOptions.reduce((total, option) => total + option.extraPrice, 0);

      lines.push({
        menuItemId: item.id,
        name: item.name,
        imageUrl: item.imageUrl || null,
        unitPrice,
        quantity: line.quantity,
        note: line.note ?? null,
        options: selectedOptions,
        lineTotal: (unitPrice + extras) * line.quantity,
      });
    }

    const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);

    const baseDeliveryFee =
      input.orderType === OrderType.DELIVERY ? restaurant.deliveryFee : 0;

    // Livraison offerte au-delà du seuil : c'est une règle du restaurant,
    // pas une promotion, elle s'applique donc avant les coupons.
    const deliveryFee =
      input.orderType === OrderType.DELIVERY &&
      restaurant.freeDeliveryThreshold !== null &&
      subtotal >= restaurant.freeDeliveryThreshold
        ? 0
        : baseDeliveryFee;

    const { discount, promotion } = await this.applyPromotion(
      client,
      input.promotionCode ?? null,
      subtotal,
      deliveryFee,
      input.customerId,
    );

    const total = clampToZero(subtotal + deliveryFee - discount);

    const estimatedPreparationMinutes = Math.max(
      restaurant.averagePreparationMinutes,
      ...lines.map((line) => itemById.get(line.menuItemId)?.preparationMinutes ?? 0),
    );

    return {
      lines,
      subtotal,
      deliveryFee,
      discount,
      total,
      promotion,
      currency: restaurant.currency,
      minimumOrder: restaurant.minimumOrderAmount,
      freeDeliveryThreshold: restaurant.freeDeliveryThreshold,
      estimatedPreparationMinutes,
    };
  }

  /**
   * Vérifie les options choisies : appartenance au plat, disponibilité,
   * et respect des contraintes du groupe (obligatoire, min/max).
   */
  private resolveOptions(
    item: {
      id: string;
      name: string;
      optionGroups: {
        id: string;
        name: string;
        isRequired: boolean;
        minSelect: number;
        maxSelect: number;
        options: { id: string; name: string; extraPrice: number; isAvailable: boolean }[];
      }[];
    },
    optionIds: string[],
  ): PricedLineOption[] {
    const selected: PricedLineOption[] = [];
    const countByGroup = new Map<string, number>();
    const unique = [...new Set(optionIds)];

    for (const optionId of unique) {
      const group = item.optionGroups.find((candidate) =>
        candidate.options.some((option) => option.id === optionId),
      );

      if (!group) {
        throw AppException.badRequest(
          ERROR_CODES.MENU_OPTION_INVALID,
          `Une option choisie n'appartient pas au plat « ${item.name} ».`,
        );
      }

      const option = group.options.find((candidate) => candidate.id === optionId)!;

      if (!option.isAvailable) {
        throw AppException.conflict(
          ERROR_CODES.MENU_OPTION_INVALID,
          `L'option « ${option.name} » n'est plus disponible.`,
        );
      }

      countByGroup.set(group.id, (countByGroup.get(group.id) ?? 0) + 1);

      selected.push({
        optionId: option.id,
        groupName: group.name,
        optionName: option.name,
        extraPrice: option.extraPrice,
      });
    }

    for (const group of item.optionGroups) {
      const count = countByGroup.get(group.id) ?? 0;

      if (group.isRequired && count < Math.max(1, group.minSelect)) {
        throw AppException.badRequest(
          ERROR_CODES.OPTION_GROUP_REQUIRED,
          `Choisissez « ${group.name} » pour « ${item.name} ».`,
        );
      }

      if (count > 0 && count < group.minSelect) {
        throw AppException.badRequest(
          ERROR_CODES.MENU_OPTION_INVALID,
          `« ${group.name} » demande au moins ${group.minSelect} choix.`,
        );
      }

      if (count > group.maxSelect) {
        throw AppException.badRequest(
          ERROR_CODES.MENU_OPTION_INVALID,
          `« ${group.name} » accepte au maximum ${group.maxSelect} choix.`,
        );
      }
    }

    return selected;
  }

  /**
   * Applique un code promotionnel.
   *
   * Toutes les limites sont vérifiées ici : validité, période, minimum de
   * commande, quota global et quota par client. Un code invalide échoue
   * franchement plutôt que d'être ignoré en silence — le client doit
   * comprendre pourquoi la remise n'apparaît pas.
   */
  private async applyPromotion(
    client: Prisma.TransactionClient,
    code: string | null,
    subtotal: number,
    deliveryFee: number,
    customerId?: string,
  ): Promise<{ discount: number; promotion: PriceQuote['promotion'] }> {
    if (!code) return { discount: 0, promotion: null };

    const promotion = await client.promotion.findFirst({
      where: { code: code.trim().toUpperCase(), deletedAt: null },
    });

    if (!promotion || !promotion.isActive) {
      throw AppException.badRequest(
        ERROR_CODES.PROMOTION_NOT_FOUND,
        'Ce code promotionnel est invalide.',
      );
    }

    const now = new Date();
    if (promotion.startsAt > now || promotion.endsAt < now) {
      throw AppException.badRequest(
        ERROR_CODES.PROMOTION_EXPIRED,
        "Ce code promotionnel n'est plus valable.",
      );
    }

    if (subtotal < promotion.minimumOrder) {
      throw AppException.badRequest(
        ERROR_CODES.PROMOTION_MINIMUM_NOT_REACHED,
        `Ce code s'applique à partir de ${promotion.minimumOrder} GNF de commande.`,
      );
    }

    if (promotion.usageLimit !== null && promotion.usageCount >= promotion.usageLimit) {
      throw AppException.badRequest(
        ERROR_CODES.PROMOTION_LIMIT_REACHED,
        'Ce code promotionnel a atteint sa limite d’utilisation.',
      );
    }

    if (promotion.perCustomerLimit !== null && customerId) {
      const used = await client.couponUsage.count({
        where: { promotionId: promotion.id, userId: customerId },
      });
      if (used >= promotion.perCustomerLimit) {
        throw AppException.badRequest(
          ERROR_CODES.PROMOTION_LIMIT_REACHED,
          'Vous avez déjà utilisé ce code promotionnel.',
        );
      }
    }

    let discount = 0;
    switch (promotion.type) {
      case PromotionType.PERCENTAGE:
        discount = capDiscount(percentageOf(subtotal, promotion.value), promotion.maxDiscount);
        break;
      case PromotionType.FIXED:
        discount = capDiscount(Math.min(promotion.value, subtotal), promotion.maxDiscount);
        break;
      case PromotionType.FREE_DELIVERY:
        discount = deliveryFee;
        break;
      default:
        discount = 0;
    }

    return {
      discount,
      promotion: {
        id: promotion.id,
        code: promotion.code,
        type: promotion.type.toLowerCase(),
        label: promotion.name,
      },
    };
  }
}
