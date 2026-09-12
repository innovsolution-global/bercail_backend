import { Injectable } from '@nestjs/common';
import { OrderType } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { PrismaService } from '../database/prisma.service';
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
      };
    }

    const orderType = query.orderType === 'pickup' ? OrderType.PICKUP : OrderType.DELIVERY;

    // Un plat devenu indisponible ne doit pas bloquer l'affichage du
    // panier : on le signale, le client le retire lui-même.
    const unavailable = items.filter((item) => !item.menuItem.isAvailable);
    const priceable = items.filter((item) => item.menuItem.isAvailable);

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
          isAvailable: item.menuItem.isAvailable,
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

    const cart = await this.ensureCart(userId);
    const optionIds = [...new Set(dto.optionIds ?? [])].sort();

    /*
     * **Un panier, une cuisine.**
     *
     * Un plat appartient à une carte, une carte à une maison : le panier
     * qui en mélange deux ne peut être ni chiffré ni cuisiné. Cela
     * n'arrive pas depuis l'écran — la carte servie est celle d'une
     * seule maison — mais la carte peut changer entre deux ajouts, quand
     * le client enregistre une adresse plus proche d'une autre maison.
     * On le lui dit, avec les noms, plutôt que de le laisser découvrir
     * un panier en erreur.
     */
    const dejaLa = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id },
      select: { menuItem: { select: { restaurantId: true, restaurant: { select: { name: true } } } } },
    });
    if (dejaLa) {
      const nouveau = await this.prisma.menuItem.findUnique({
        where: { id: dto.menuItemId },
        select: { restaurantId: true, restaurant: { select: { name: true } } },
      });
      if (nouveau && nouveau.restaurantId !== dejaLa.menuItem.restaurantId) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `Votre panier contient des plats de « ${dejaLa.menuItem.restaurant.name} ». ` +
            `Videz-le pour commander chez « ${nouveau.restaurant.name} ».`,
        );
      }
    }

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
