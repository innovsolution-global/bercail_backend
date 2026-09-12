import { Injectable } from '@nestjs/common';
import { Prisma, Promotion, PromotionType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import type { CreatePromotionDto, PromotionQueryDto, UpdatePromotionDto } from './dto/promotion.dto';

/**
 * Promotions et coupons.
 *
 * Le calcul de la remise n'est pas ici : il appartient au moteur de prix,
 * qui est la seule autorité sur les montants. Ce service gère le cycle de
 * vie des codes (création, périodes, quotas) et leur consultation.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: RestaurantScopeService,
  ) {}

  async list(query: PromotionQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.PromotionWhereInput = { deletedAt: null };

    if (query.isActive === 'active') where.isActive = true;
    if (query.isActive === 'inactive') where.isActive = false;

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.promotion.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);
  }

  /** Promotions visibles par un client dans l'application mobile. */
  async publicList() {
    const now = new Date();
    const promotions = await this.prisma.promotion.findMany({
      where: {
        // La bande d'offres de l'accueil accompagne une carte : elle
        // annonce celles de la maison dont on lit les plats, pas celles
        // d'à côté, qu'on ne pourrait pas utiliser.
        restaurantId: await this.scope.publicRestaurantId(),
        deletedAt: null,
        isActive: true,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { endsAt: 'asc' },
      take: 20,
    });

    return promotions
      .filter(
        (promotion) => promotion.usageLimit === null || promotion.usageCount < promotion.usageLimit,
      )
      .map((promotion) => ({
        id: promotion.id,
        name: promotion.name,
        description: promotion.description,
        // C'est l'application client qui affiche la carte : sans le visuel
        // ici, la photo ne servirait qu'au back-office.
        imageUrl: promotion.imageUrl,
        code: promotion.code,
        type: toWire(promotion.type),
        value: promotion.value,
        minimumOrder: promotion.minimumOrder,
        maxDiscount: promotion.maxDiscount,
        endsAt: promotion.endsAt.toISOString(),
      }));
  }

  async findOne(id: string) {
    const promotion = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!promotion) throw AppException.notFound('Promotion introuvable.');

    const usages = await this.prisma.couponUsage.findMany({
      where: { promotionId: id },
      include: {
        user: { select: { firstName: true, lastName: true } },
        order: { select: { reference: true, total: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      ...this.toDto(promotion),
      usages: usages.map((usage) => ({
        customerName: `${usage.user.firstName} ${usage.user.lastName}`.trim(),
        orderReference: usage.order.reference,
        discountAmount: usage.discountAmount,
        at: usage.createdAt.toISOString(),
      })),
    };
  }

  async create(dto: CreatePromotionDto, actor: AuthenticatedUser, context: RequestContext) {
    const code = dto.code.trim().toUpperCase();
    const type = (parseEnum(PromotionType, dto.type) ?? PromotionType.PERCENTAGE) as PromotionType;

    this.assertConsistent(type, dto.value, dto.startsAt, dto.endsAt);

    const existing = await this.prisma.promotion.findUnique({ where: { code } });
    if (existing) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce code promotionnel existe déjà.');
    }

    const promotion = await this.prisma.promotion.create({
      data: {
        restaurantId: this.scope.resolve(dto.restaurantId),
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl || null,
        code,
        type,
        value: dto.value,
        minimumOrder: dto.minimumOrder ?? 0,
        maxDiscount: dto.maxDiscount ?? null,
        usageLimit: dto.usageLimit ?? null,
        perCustomerLimit: dto.perCustomerLimit ?? null,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        isActive: dto.isActive ?? true,
      },
    });

    await this.audit.record({
      actor,
      action: 'PROMOTION_CREATE',
      module: 'promotions',
      entityType: 'Promotion',
      entityId: promotion.id,
      newValue: { code, type, value: dto.value },
      context,
    });

    return this.toDto(promotion);
  }

  async update(
    id: string,
    dto: UpdatePromotionDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Promotion introuvable.');

    const type = dto.type ? ((parseEnum(PromotionType, dto.type) ?? existing.type) as PromotionType) : existing.type;
    const value = dto.value ?? existing.value;
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : existing.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : existing.endsAt;

    this.assertConsistent(type, value, startsAt.toISOString(), endsAt.toISOString());

    const promotion = await this.prisma.promotion.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        /*
         * `undefined` laisse le visuel en place, la chaîne vide le retire.
         * Sans cette distinction, on ne pourrait plus jamais enlever une
         * image une fois posée : Prisma ignore `undefined`.
         */
        imageUrl: dto.imageUrl === undefined ? undefined : dto.imageUrl || null,
        type,
        value,
        minimumOrder: dto.minimumOrder,
        maxDiscount: dto.maxDiscount,
        usageLimit: dto.usageLimit,
        perCustomerLimit: dto.perCustomerLimit,
        startsAt,
        endsAt,
        isActive: dto.isActive,
        ...(dto.code ? { code: dto.code.trim().toUpperCase() } : {}),
      },
    });

    await this.audit.record({
      actor,
      action: 'PROMOTION_UPDATE',
      module: 'promotions',
      entityType: 'Promotion',
      entityId: id,
      oldValue: {
        code: existing.code,
        type: existing.type,
        value: existing.value,
        isActive: existing.isActive,
      },
      newValue: {
        code: promotion.code,
        type: promotion.type,
        value: promotion.value,
        isActive: promotion.isActive,
      },
      context,
    });

    return this.toDto(promotion);
  }

  async setActive(
    id: string,
    isActive: boolean,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Promotion introuvable.');

    const promotion = await this.prisma.promotion.update({ where: { id }, data: { isActive } });

    await this.audit.record({
      actor,
      action: isActive ? 'PROMOTION_ACTIVATE' : 'PROMOTION_DEACTIVATE',
      module: 'promotions',
      entityType: 'Promotion',
      entityId: id,
      oldValue: { isActive: existing.isActive },
      newValue: { isActive },
      context,
    });

    return this.toDto(promotion);
  }

  /**
   * Suppression logique : les commandes passées gardent la trace du code
   * utilisé, et les statistiques restent justes.
   */
  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Promotion introuvable.');

    await this.prisma.promotion.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actor,
      action: 'PROMOTION_DELETE',
      module: 'promotions',
      entityType: 'Promotion',
      entityId: id,
      oldValue: { code: existing.code, usageCount: existing.usageCount },
      context,
    });

    return { success: true };
  }

  /** Vérification d'un code par le client, avant de valider son panier. */
  /**
   * @param publicOnly Vérification faite pour un client : elle est alors
   *   ramenée à l'établissement qu'il consulte. Un compte du back-office
   *   garde sa propre portée — le propriétaire doit pouvoir contrôler un
   *   code de n'importe laquelle de ses maisons.
   */
  async check(code: string, publicOnly = false) {
    const promotion = await this.prisma.promotion.findFirst({
      where: {
        code: code.trim().toUpperCase(),
        deletedAt: null,
        // Le refus est le même que pour un code inexistant : dire « ce
        // code appartient à une autre adresse » révélerait l'offre d'une
        // maison à la clientèle d'une autre.
        ...(publicOnly ? { restaurantId: await this.scope.publicRestaurantId() } : {}),
      },
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

    return {
      code: promotion.code,
      name: promotion.name,
      type: toWire(promotion.type),
      value: promotion.value,
      minimumOrder: promotion.minimumOrder,
      maxDiscount: promotion.maxDiscount,
      endsAt: promotion.endsAt.toISOString(),
    };
  }

  private assertConsistent(type: PromotionType, value: number, startsAt: string, endsAt: string) {
    if (new Date(startsAt) >= new Date(endsAt)) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'La date de fin doit être postérieure à la date de début.',
      );
    }

    if (type === PromotionType.PERCENTAGE && (value <= 0 || value > 100)) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Un pourcentage de remise doit être compris entre 1 et 100.',
      );
    }

    if (type === PromotionType.FIXED && value <= 0) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Une remise fixe doit être supérieure à zéro.',
      );
    }
  }

  private toDto(promotion: Promotion) {
    return {
      id: promotion.id,
      name: promotion.name,
      description: promotion.description,
      imageUrl: promotion.imageUrl,
      code: promotion.code,
      type: toWire(promotion.type),
      value: promotion.value,
      minimumOrder: promotion.minimumOrder,
      maxDiscount: promotion.maxDiscount,
      usageLimit: promotion.usageLimit,
      usageCount: promotion.usageCount,
      perCustomerLimit: promotion.perCustomerLimit,
      startsAt: promotion.startsAt.toISOString(),
      endsAt: promotion.endsAt.toISOString(),
      isActive: promotion.isActive,
      createdAt: promotion.createdAt.toISOString(),
    };
  }
}
