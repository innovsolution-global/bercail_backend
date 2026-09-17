import { Injectable } from '@nestjs/common';
import { OrderType } from '@prisma/client';
import { DishAvailabilityService } from '../common/context/dish-availability.service';
import { restaurantContext } from '../common/context/restaurant-context';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { PrismaService } from '../database/prisma.service';
import { KitchenSelector } from '../orders/kitchen-selector.service';
import { PricingService, type LineInput } from '../orders/pricing.service';
import type { AddCartItemDto, CartQueryDto, UpdateCartItemDto } from './dto/cart.dto';

/**
 * Panier du client.
 *
 * Le panier ne stocke aucun montant : uniquement des plats, des options
 * et des quantités. Les prix sont recalculés à chaque lecture, ce qui
 * évite le grand classique du panier figé à l'ancien tarif.
 *
 * Conséquence assumée : si le restaurant change un prix, le panier suit.
 */
@Injectable()
export class CartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly availability: DishAvailabilityService,
    private readonly kitchens: KitchenSelector,
  ) {}

  private async ensureCart(userId: string) {
    const cart = await this.prisma.cart.findUnique({ where: { userId } });
    if (cart) return cart;
    return this.prisma.cart.create({ data: { userId } });
  }

  /** Panier complet, avec le détail des prix recalculés. */
  async get(userId: string, query: CartQueryDto = {}) {
    const cart = await this.ensureCart(userId);

    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: {
        menuItem: { select: { id: true, name: true, imageUrl: true, isAvailable: true } },
        options: { include: { option: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (items.length === 0) {
      return {
        id: cart.id,
        items: [],
        itemsCount: 0,
        subtotal: 0,
        deliveryFee: 0,
        discount: 0,
        total: 0,
        promotion: null,
        currency: 'GNF',
        minimumOrder: 0,
        meetsMinimum: false,
        unavailableItems: [],
        kitchen: null,
      };
    }

    const orderType = query.orderType === 'pickup' ? OrderType.PICKUP : OrderType.DELIVERY;

    // Un plat devenu indisponible ne doit pas bloquer l'affichage du
    // panier : on le signale, le client le retire lui-même.
    //
    // « Indisponible » : retiré de la carte, ou épuisé dans toutes les
    // maisons. Épuisé dans une seule, il reste commandable — la commande
    // partira d'une autre cuisine.
    const epuisesPartout = new Set(
      await this.availability.soldOutEverywhere(items.map((item) => item.menuItemId)),
    );
    const alaCarte = items.filter(
      (item) => item.menuItem.isAvailable && !epuisesPartout.has(item.menuItemId),
    );

    /*
     * Chez qui chiffrer.
     *
     * C'est ce panier que l'application montre au moment de payer : ses
     * frais et son minimum doivent être ceux de la maison qui préparera.
     * Si la maison qui sert le client n'a plus l'un des plats, la
     * commande basculera ailleurs — le panier est donc chiffré là-bas,
     * et le dit. Et quand aucune maison ne peut tout préparer, les plats
     * qui manquent chez la plus proche sont signalés indisponibles : le
     * client les retire, et le reste part de chez elle.
     */
    const choix =
      alaCarte.length > 0
        ? await this.kitchens.choose({
            nearestId: null,
            position: restaurantContext.current()?.position ?? null,
            menuItemIds: alaCarte.map((item) => item.menuItemId),
            orderType,
          })
        : null;

    const manquants = new Set(choix && !choix.ok ? choix.soldOut.map((dish) => dish.id) : []);
    const commandable = (item: (typeof items)[number]) =>
      item.menuItem.isAvailable &&
      !epuisesPartout.has(item.menuItemId) &&
      !manquants.has(item.menuItemId);

    const unavailable = items.filter((item) => !commandable(item));
    const priceable = items.filter(commandable);

    const cuisine = choix ? (choix.ok ? choix.restaurant : choix.nearest) : null;

    const quote =
      priceable.length > 0
        ? await this.pricing.quote({
            lines: priceable.map<LineInput>((item) => ({
              menuItemId: item.menuItemId,
              quantity: item.quantity,
              optionIds: item.options.map((option) => option.optionId),
              note: item.note,
            })),
            orderType,
            promotionCode: query.promotionCode ?? null,
            customerId: userId,
            restaurantId: cuisine?.id,
          })
        : null;

    const lineByItem = new Map(
      priceable.map((item, index) => [item.id, quote?.lines[index] ?? null]),
    );

    return {
      id: cart.id,
      items: items.map((item) => {
        const line = lineByItem.get(item.id);
        return {
          id: item.id,
          menuItemId: item.menuItemId,
          name: item.menuItem.name,
          imageUrl: item.menuItem.imageUrl || null,
          quantity: item.quantity,
          note: item.note,
          isAvailable: commandable(item),
          unitPrice: line?.unitPrice ?? 0,
          lineTotal: line?.lineTotal ?? 0,
          options:
            line?.options.map((option) => ({
              id: option.optionId,
              groupName: option.groupName,
              name: option.optionName,
              extraPrice: option.extraPrice,
            })) ?? [],
        };
      }),
      itemsCount: items.reduce((total, item) => total + item.quantity, 0),
      subtotal: quote?.subtotal ?? 0,
      deliveryFee: quote?.deliveryFee ?? 0,
      discount: quote?.discount ?? 0,
      total: quote?.total ?? 0,
      promotion: quote?.promotion ?? null,
      currency: quote?.currency ?? 'GNF',
      minimumOrder: quote?.minimumOrder ?? 0,
      meetsMinimum: (quote?.subtotal ?? 0) >= (quote?.minimumOrder ?? 0),
      estimatedPreparationMinutes: quote?.estimatedPreparationMinutes ?? null,
      unavailableItems: unavailable.map((item) => ({
        id: item.id,
        menuItemId: item.menuItemId,
        name: item.menuItem.name,
      })),
      /** La maison qui préparera, et celle qui a passé la main, le cas échéant. */
      kitchen: cuisine
        ? {
            id: cuisine.id,
            name: cuisine.name,
            divertedFrom:
              choix?.ok && choix.divertedFrom
                ? { id: choix.divertedFrom.id, name: choix.divertedFrom.name, soldOut: choix.divertedFrom.soldOut }
                : null,
          }
        : null,
    };
  }

  /**
   * Ajout d'une ligne.
   *
   * Deux ajouts du même plat avec exactement les mêmes options fusionnent :
   * c'est ce que fait l'application mobile, et cela évite un panier illisible.
   */
  async addItem(userId: string, dto: AddCartItemDto) {
    // Validation complète (disponibilité, options, quantité) avant écriture.
    await this.pricing.quote({
      lines: [
        { menuItemId: dto.menuItemId, quantity: dto.quantity, optionIds: dto.optionIds ?? [] },
      ],
      orderType: OrderType.DELIVERY,
      customerId: userId,
    });

    // Le moteur de prix ne connaît que l'interrupteur global ; un plat
    // épuisé dans toutes les maisons n'est pas plus commandable.
    if ((await this.availability.soldOutEverywhere([dto.menuItemId])).length > 0) {
      throw AppException.conflict(
        ERROR_CODES.MENU_ITEM_UNAVAILABLE,
        'Ce plat est épuisé dans toutes nos maisons pour le moment.',
        { menuItemId: dto.menuItemId },
      );
    }

    const cart = await this.ensureCart(userId);
    const optionIds = [...new Set(dto.optionIds ?? [])].sort();

    // Plus de contrôle « un panier, une cuisine » : la carte est commune à
    // toutes les maisons, un panier ne peut donc plus en mélanger deux.

    const existing = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id, menuItemId: dto.menuItemId },
      include: { options: true },
    });

    const twin = existing.find((item) => {
      const current = item.options.map((option) => option.optionId).sort();
      return (
        current.length === optionIds.length &&
        current.every((value, index) => value === optionIds[index]) &&
        (item.note ?? '') === (dto.note ?? '')
      );
    });

    if (twin) {
      await this.prisma.cartItem.update({
        where: { id: twin.id },
        data: { quantity: Math.min(twin.quantity + dto.quantity, 50) },
      });
    } else {
      await this.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          menuItemId: dto.menuItemId,
          quantity: dto.quantity,
          note: dto.note,
          options: { create: optionIds.map((optionId) => ({ optionId })) },
        },
      });
    }

    return this.get(userId);
  }

  async updateItem(userId: string, itemId: string, dto: UpdateCartItemDto) {
    const cart = await this.ensureCart(userId);
    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
    });
    if (!item) throw AppException.notFound('Ligne de panier introuvable.');

    if (dto.quantity === 0) {
      await this.prisma.cartItem.delete({ where: { id: itemId } });
      return this.get(userId);
    }

    if (dto.optionIds) {
      await this.pricing.quote({
        lines: [
          {
            menuItemId: item.menuItemId,
            quantity: dto.quantity ?? item.quantity,
            optionIds: dto.optionIds,
          },
        ],
        orderType: OrderType.DELIVERY,
        customerId: userId,
      });
    }

    await this.prisma.transaction(async (tx) => {
      await tx.cartItem.update({
        where: { id: itemId },
        data: {
          ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
      });

      if (dto.optionIds) {
        await tx.cartItemOption.deleteMany({ where: { cartItemId: itemId } });
        const unique = [...new Set(dto.optionIds)];
        if (unique.length > 0) {
          await tx.cartItemOption.createMany({
            data: unique.map((optionId) => ({ cartItemId: itemId, optionId })),
          });
        }
      }
    });

    return this.get(userId);
  }

  async removeItem(userId: string, itemId: string) {
    const cart = await this.ensureCart(userId);
    const deleted = await this.prisma.cartItem.deleteMany({
      where: { id: itemId, cartId: cart.id },
    });
    if (deleted.count === 0) throw AppException.notFound('Ligne de panier introuvable.');
    return this.get(userId);
  }

  async clear(userId: string) {
    const cart = await this.ensureCart(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.get(userId);
  }

  /** Lignes du panier, prêtes pour la création de commande. */
  async toLineInputs(userId: string): Promise<LineInput[]> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { options: true }, orderBy: { createdAt: 'asc' } } },
    });

    if (!cart || cart.items.length === 0) {
      throw AppException.badRequest(ERROR_CODES.CART_EMPTY, 'Votre panier est vide.');
    }

    return cart.items.map((item) => ({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      optionIds: item.options.map((option) => option.optionId),
      note: item.note,
    }));
  }
}
