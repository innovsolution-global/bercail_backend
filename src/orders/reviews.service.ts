import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import type { CreateReviewDto } from './dto/review.dto';

/** Un avis, tel qu'il est rendu au client et au back-office. */
export interface ReviewDto {
  id: string;
  orderId: string;
  restaurantRating: number;
  driverRating: number | null;
  comment: string | null;
  items: { orderItemId: string; menuItemId: string | null; name: string; rating: number }[];
  createdAt: string;
}

/**
 * Les avis des clients.
 *
 * Un avis par commande livrée : la maison, le livreur s'il y en a eu un,
 * et les plats un par un. Les moyennes — de la maison, du livreur, de
 * chaque plat — sont **recalculées** à chaque avis, depuis la table des
 * avis : une moyenne entretenue à la main dérive à la première erreur,
 * et personne ne s'en aperçoit avant longtemps.
 *
 * Les notes de plats vivaient dans le téléphone du client et
 * n'arrivaient nulle part. Le propriétaire a tranché : une étoile qui
 * ne compte pour rien est un mensonge — elle est branchée, et le
 * livreur et la maison se notent aussi.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /** L'avis d'une commande, ou `null` s'il n'a pas encore été donné. */
  async forOrder(user: AuthenticatedUser, orderId: string): Promise<ReviewDto | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { customerId: true, delivery: { select: { driverId: true } } },
    });
    if (!order) throw AppException.notFound('Commande introuvable.');
    this.assertCanRead(user, order.customerId, order.delivery?.driverId ?? null);

    const review = await this.prisma.orderReview.findUnique({
      where: { orderId },
      include: { items: { include: { orderItem: { select: { name: true } } } } },
    });

    return review ? this.toDto(review) : null;
  }

  /**
   * Dépose l'avis d'une commande.
   *
   * Seul le client destinataire, seulement une fois la commande livrée,
   * et une seule fois : un avis modifiable après coup vaudrait moins —
   * on ne renote pas un repas trois jours plus tard.
   */
  async create(user: AuthenticatedUser, orderId: string, dto: CreateReviewDto): Promise<ReviewDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: {
        items: { select: { id: true, menuItemId: true } },
        delivery: { select: { driverId: true } },
        review: { select: { id: true } },
      },
    });
    if (!order) throw AppException.notFound('Commande introuvable.');

    if (user.role !== Role.CUSTOMER || order.customerId !== user.id) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Seul le client qui a passé la commande peut la noter.',
      );
    }

    if (order.status !== OrderStatus.DELIVERED) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Vous pourrez noter cette commande une fois qu’elle vous aura été remise.',
      );
    }

    if (order.review) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Vous avez déjà noté cette commande.');
    }

    const driverId = order.delivery?.driverId ?? null;
    if (dto.driverRating !== undefined && !driverId) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Cette commande n’a pas eu de livreur à noter.',
      );
    }

    // Chaque plat noté doit être un plat de **cette** commande : on ne
    // note pas ce qu'on n'a pas mangé.
    const lignes = new Map(order.items.map((item) => [item.id, item.menuItemId]));
    const notes = dto.items ?? [];
    for (const note of notes) {
      if (!lignes.has(note.orderItemId)) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'Un des plats notés ne fait pas partie de cette commande.',
        );
      }
    }
    if (new Set(notes.map((note) => note.orderItemId)).size !== notes.length) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Un même plat est noté deux fois.',
      );
    }

    const review = await this.prisma.transaction(async (tx) => {
      const created = await tx.orderReview.create({
        data: {
          orderId,
          customerId: user.id,
          restaurantId: order.restaurantId,
          restaurantRating: dto.restaurantRating,
          driverId: dto.driverRating !== undefined ? driverId : null,
          driverRating: dto.driverRating ?? null,
          comment: dto.comment?.trim() || null,
          items: {
            create: notes.map((note) => ({
              orderItemId: note.orderItemId,
              menuItemId: lignes.get(note.orderItemId) ?? null,
              rating: note.rating,
            })),
          },
        },
        include: { items: { include: { orderItem: { select: { name: true } } } } },
      });

      await this.refreshRestaurant(tx, order.restaurantId);
      if (dto.driverRating !== undefined && driverId) {
        await this.refreshDriver(tx, driverId);
      }
      for (const menuItemId of new Set(
        notes.map((note) => lignes.get(note.orderItemId)).filter((id): id is string => Boolean(id)),
      )) {
        await this.refreshMenuItem(tx, menuItemId);
      }

      return created;
    });

    return this.toDto(review);
  }

  // ── Les moyennes, recalculées depuis la table des avis ──────────────

  private async refreshRestaurant(tx: Prisma.TransactionClient, restaurantId: string) {
    const agg = await tx.orderReview.aggregate({
      where: { restaurantId },
      _avg: { restaurantRating: true },
      _count: { _all: true },
    });
    await tx.restaurant.update({
      where: { id: restaurantId },
      data: { rating: this.round(agg._avg.restaurantRating), reviewCount: agg._count._all },
    });
  }

  private async refreshDriver(tx: Prisma.TransactionClient, driverId: string) {
    const agg = await tx.orderReview.aggregate({
      where: { driverId, driverRating: { not: null } },
      _avg: { driverRating: true },
    });
    await tx.driverProfile.update({
      where: { id: driverId },
      data: { rating: this.round(agg._avg.driverRating) },
    });
  }

  private async refreshMenuItem(tx: Prisma.TransactionClient, menuItemId: string) {
    const agg = await tx.orderItemReview.aggregate({
      where: { menuItemId },
      _avg: { rating: true },
      _count: { _all: true },
    });
    await tx.menuItem.update({
      where: { id: menuItemId },
      data: { rating: this.round(agg._avg.rating), reviewCount: agg._count._all },
    });
  }

  /** Une décimale : « 4,3 », pas « 4,333333 ». */
  private round(value: number | null): number | null {
    return value === null ? null : Math.round(value * 10) / 10;
  }

  private assertCanRead(user: AuthenticatedUser, customerId: string | null, driverId: string | null) {
    if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) return;
    if (user.role === Role.CUSTOMER && customerId === user.id) return;
    if (user.role === Role.DRIVER && driverId && user.driverProfileId === driverId) return;
    throw AppException.forbidden(ERROR_CODES.FORBIDDEN, "Vous n'avez pas accès à cette commande.");
  }

  private toDto(
    review: Prisma.OrderReviewGetPayload<{
      include: { items: { include: { orderItem: { select: { name: true } } } } };
    }>,
  ): ReviewDto {
    return {
      id: review.id,
      orderId: review.orderId,
      restaurantRating: review.restaurantRating,
      driverRating: review.driverRating,
      comment: review.comment,
      items: review.items.map((item) => ({
        orderItemId: item.orderItemId,
        menuItemId: item.menuItemId,
        name: item.orderItem.name,
        rating: item.rating,
      })),
      createdAt: review.createdAt.toISOString(),
    };
  }
}
