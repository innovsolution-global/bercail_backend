import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { DishAvailabilityService } from '../common/context/dish-availability.service';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { generateOrderReference, generateTransactionRef } from '../common/utils/reference.util';
import { parseEnum } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SettingsService } from '../settings/settings.service';
import { RecipesService } from '../finance/recipes.service';
import type { CreatePosOrderDto, QuotePosOrderDto } from './dto/pos.dto';
import { describeSoldOut } from './kitchen-selector.service';
import { ORDER_DETAIL_INCLUDE, toOrderDetail, toOrderSummary } from './order.mapper';
import { PricingService, type LineInput } from './pricing.service';

/**
 * Caisse — commandes prises sur place.
 *
 * Le restaurant vend aussi à des gens qui poussent la porte : ces ventes
 * doivent entrer dans le même registre que celles de l'application, sinon
 * le chiffre d'affaires du mois est faux.
 *
 * Deux différences assumées avec une commande de l'application :
 *  • il n'y a pas de compte client — `customerId` est nul, on garde au
 *    mieux un nom et un téléphone donnés au comptoir ;
 *  • ni le minimum de commande ni les horaires d'ouverture ne s'appliquent :
 *    si quelqu'un est devant la caisse, le restaurant est ouvert.
 *
 * Ce qui ne change pas : les prix. Ils sont relus en base et recalculés
 * par le même moteur, la caisse n'envoie aucun montant.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly recipes: RecipesService,
    private readonly config: ConfigService,
    private readonly availability: DishAvailabilityService,
  ) {}

  /**
   * Un plat épuisé ici ne se vend pas ici.
   *
   * La rupture est propre à chaque maison, et une commande de
   * l'application bascule chez une autre quand la plus proche n'a plus
   * un plat. Pas au comptoir : le client est devant cette cuisine-là.
   * Le moteur de prix ne connaît que l'interrupteur de l'enseigne, d'où
   * ce contrôle ici.
   */
  private async assertNothingSoldOut(restaurantId: string, lines: LineInput[]): Promise<void> {
    const epuises = await this.availability.soldOutAt(
      restaurantId,
      lines.map((line) => line.menuItemId),
    );
    if (epuises.length === 0) return;

    throw AppException.conflict(
      ERROR_CODES.MENU_ITEM_UNAVAILABLE,
      `${describeSoldOut(epuises)} dans cet établissement.`,
      { menuItemIds: epuises.map((dish) => dish.id), restaurantId },
    );
  }

  /** Aperçu du ticket : ce que la caisse affiche avant d'encaisser. */
  async quote(dto: QuotePosOrderDto) {
    const restaurant = await this.settings.getRestaurantCached();
    const lines = this.toLines(dto.items);
    await this.assertNothingSoldOut(restaurant.id, lines);

    const quote = await this.pricing.quote({
      lines,
      orderType: this.orderType(dto.type),
      restaurantId: restaurant.id,
    });

    const discount = this.clampDiscount(dto.discount ?? 0, quote.subtotal);

    return {
      lines: quote.lines,
      subtotal: quote.subtotal,
      discount,
      total: quote.subtotal - discount,
      currency: quote.currency,
      estimatedPreparationMinutes: quote.estimatedPreparationMinutes,
    };
  }

  /**
   * Encaisse une vente au comptoir.
   *
   * Tout est écrit dans une seule transaction : la commande, ses lignes,
   * le paiement et l'historique. Une caisse qui plante au milieu ne laisse
   * pas une vente à moitié enregistrée.
   */
  async create(dto: CreatePosOrderDto, actor: AuthenticatedUser, context: RequestContext) {
    const restaurant = await this.settings.getRestaurantCached();
    const orderType = this.orderType(dto.type);
    const paymentMethod = (parseEnum(PaymentMethod, dto.paymentMethod) ??
      PaymentMethod.CASH_ON_DELIVERY) as PaymentMethod;

    const servedImmediately = dto.servedImmediately ?? true;
    const paid = dto.paid ?? true;

    const lines = this.toLines(dto.items);
    await this.assertNothingSoldOut(restaurant.id, lines);

    const created = await this.prisma.transaction(async (tx) => {
      const quote = await this.pricing.quote(
        { lines, orderType, restaurantId: restaurant.id },
        tx,
      );

      const discount = this.clampDiscount(dto.discount ?? 0, quote.subtotal);
      const total = quote.subtotal - discount;

      // Le rendu de monnaie n'est calculé que si la caisse a saisi ce que
      // le client a tendu — et il ne peut pas être négatif.
      if (dto.amountReceived !== undefined && dto.amountReceived < total) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'La somme reçue est inférieure au montant à payer.',
          { total, amountReceived: dto.amountReceived },
        );
      }

      const changeGiven =
        dto.amountReceived !== undefined ? dto.amountReceived - total : null;

      const now = new Date();
      const status = servedImmediately ? OrderStatus.DELIVERED : OrderStatus.CONFIRMED;

      return tx.order.create({
        data: {
          reference: generateOrderReference(
            this.config.get<string>('orders.referencePrefix') ?? 'BRC',
            now,
          ),
          customerId: null,
          restaurantId: restaurant.id,
          channel: OrderChannel.POS,
          walkInName: dto.customerName?.trim() || null,
          walkInPhone: dto.customerPhone?.trim() || null,
          tableNumber: dto.tableNumber?.trim() || null,
          servedById: actor.id,
          amountReceived: dto.amountReceived ?? null,
          changeGiven,
          addressSnapshot: Prisma.JsonNull,
          type: orderType,
          status,
          subtotal: quote.subtotal,
          deliveryFee: 0,
          discount,
          total,
          paymentMethod,
          paymentStatus: paid ? PaymentStatus.PAID : PaymentStatus.PENDING,
          note: dto.note ?? null,
          estimatedReadyAt: new Date(now.getTime() + quote.estimatedPreparationMinutes * 60_000),
          deliveredAt: servedImmediately ? now : null,
          items: {
            create: quote.lines.map((line) => ({
              menuItemId: line.menuItemId,
              name: line.name,
              imageUrl: line.imageUrl,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              note: line.note,
              lineTotal: line.lineTotal,
              options: {
                create: line.options.map((option) => ({
                  optionId: option.optionId,
                  groupName: option.groupName,
                  optionName: option.optionName,
                  extraPrice: option.extraPrice,
                })),
              },
            })),
          },
          history: {
            create: servedImmediately
              ? [
                  {
                    status: OrderStatus.DELIVERED,
                    comment: 'Vente au comptoir',
                    actorId: actor.id,
                  },
                ]
              : [
                  {
                    status: OrderStatus.CONFIRMED,
                    comment: 'Commande prise au comptoir',
                    actorId: actor.id,
                  },
                ],
          },
          payment: {
            create: {
              transactionRef: generateTransactionRef(now),
              customerId: null,
              method: paymentMethod,
              status: paid ? PaymentStatus.PAID : PaymentStatus.PENDING,
              amount: total,
              paidAt: paid ? now : null,
              events: {
                create: {
                  label: paid ? 'Encaissement au comptoir' : 'Note ouverte au comptoir',
                  status: paid ? PaymentStatus.PAID : PaymentStatus.PENDING,
                },
              },
            },
          },
        },
        include: ORDER_DETAIL_INCLUDE,
      });
    });

    // Compteurs de popularité : hors transaction, ils ne doivent pas tenir
    // un verrou pendant que la caisse attend son ticket.
    await Promise.all(
      created.items.map((item) =>
        item.menuItemId
          ? this.prisma.menuItem.update({
              where: { id: item.menuItemId },
              data: { ordersCount: { increment: item.quantity } },
            })
          : Promise.resolve(null),
      ),
    );

    // Une vente au comptoir est préparée sur-le-champ : la matière sort
    // dans la foulée, sans attendre un changement de statut qui n'aura pas
    // lieu pour une commande déjà servie.
    await this.recipes.consumeForOrder(created.id, actor.id);

    this.realtime.orderCreated({
      ...toOrderSummary(created),
      customerId: null,
    });

    await this.audit.record({
      actor,
      action: 'POS_ORDER_CREATE',
      module: 'orders',
      entityType: 'Order',
      entityId: created.id,
      newValue: {
        reference: created.reference,
        total: created.total,
        discount: created.discount,
        type: created.type,
        paymentMethod: created.paymentMethod,
        paid,
      },
      context,
    });

    return toOrderDetail(created);
  }

  /** Chiffre de la caisse pour la journée en cours. */
  async today() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const [totals, byMethod] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          channel: OrderChannel.POS,
          deletedAt: null,
          status: { not: OrderStatus.CANCELLED },
          createdAt: { gte: start },
        },
        _sum: { total: true, discount: true },
        _count: true,
      }),
      this.prisma.order.groupBy({
        by: ['paymentMethod'],
        where: {
          channel: OrderChannel.POS,
          deletedAt: null,
          status: { not: OrderStatus.CANCELLED },
          createdAt: { gte: start },
        },
        _sum: { total: true },
        _count: true,
      }),
    ]);

    return {
      date: start.toISOString(),
      ordersCount: totals._count,
      revenue: totals._sum.total ?? 0,
      discounts: totals._sum.discount ?? 0,
      averageTicket: totals._count > 0 ? Math.round((totals._sum.total ?? 0) / totals._count) : 0,
      byPaymentMethod: byMethod.map((row) => ({
        method: row.paymentMethod.toLowerCase(),
        amount: row._sum.total ?? 0,
        count: row._count,
      })),
    };
  }

  // ────────────────────────────── Utilitaires ─────────────────────────────

  private toLines(items: { menuItemId: string; quantity: number; optionIds?: string[]; note?: string }[]): LineInput[] {
    return items.map((item) => ({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      optionIds: item.optionIds ?? [],
      note: item.note,
    }));
  }

  private orderType(type: 'dine_in' | 'pickup'): OrderType {
    return type === 'pickup' ? OrderType.PICKUP : OrderType.DINE_IN;
  }

  /** Une remise ne peut pas dépasser le sous-total : on ne rend pas d'argent. */
  private clampDiscount(discount: number, subtotal: number): number {
    return Math.max(0, Math.min(Math.round(discount), subtotal));
  }
}
