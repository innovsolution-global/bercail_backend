import { Injectable } from '@nestjs/common';
import { Prisma, Restaurant, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import type { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant.dto';

/**
 * Les établissements de l'enseigne.
 *
 * Ce service échappe volontairement au cloisonnement automatique : il est
 * celui qui dit *quels* établissements existent. C'est donc lui qui décide
 * ce que chacun a le droit de voir — un ADMIN ne connaît que le sien, le
 * propriétaire les voit tous.
 */
@Injectable()
export class RestaurantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Établissements visibles par le compte.
   *
   * Alimente le sélecteur du back-office : un ADMIN n'y trouve que son
   * restaurant — donc pas de sélecteur du tout — tandis que le propriétaire
   * y trouve la liste complète et peut basculer.
   */
  async list(actor: AuthenticatedUser) {
    /*
     * On filtre sur le rattachement du **compte**, jamais sur l'établissement
     * en cours de consultation.
     *
     * Ces deux choses n'ont rien à voir : le rattachement dit ce qu'une
     * personne a le droit de voir, la consultation dit ce qu'elle regarde à
     * cet instant. Les confondre ici aurait une conséquence absurde — dès
     * que le propriétaire choisit un établissement, la liste n'en renverrait
     * plus qu'un, le sélecteur se masquerait, et il n'y aurait plus aucun
     * moyen de revenir en arrière.
     */
    const own = actor.role === Role.SUPER_ADMIN ? null : (actor.restaurantId ?? null);

    const where: Prisma.RestaurantWhereInput = {
      deletedAt: null,
      ...(own ? { id: own } : {}),
    };

    const restaurants = await this.prisma.restaurant.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { orders: true, staff: true, menuItems: true } },
      },
    });

    return restaurants.map((restaurant) => this.toDto(restaurant, restaurant._count));
  }

  async findOne(id: string, actor: AuthenticatedUser) {
    // Même règle qu'à la liste : c'est le rattachement du compte qui décide.
    const own = actor.role === Role.SUPER_ADMIN ? null : (actor.restaurantId ?? null);
    if (own && own !== id) {
      // On répond « introuvable » plutôt que « interdit » : révéler qu'un
      // autre établissement existe n'apporte rien à qui ne peut pas le voir.
      throw AppException.notFound('Établissement introuvable.');
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, deletedAt: null },
      include: {
        openingHours: { orderBy: { weekday: 'asc' } },
        _count: { select: { orders: true, staff: true, menuItems: true } },
      },
    });

    if (!restaurant) throw AppException.notFound('Établissement introuvable.');
    return this.toDto(restaurant, restaurant._count);
  }

  /**
   * Ouvre un établissement.
   *
   * Réservé au propriétaire : un gérant d'établissement n'ouvre pas une
   * seconde adresse depuis son back-office.
   */
  async create(dto: CreateRestaurantDto, actor: AuthenticatedUser, context: RequestContext) {
    this.assertOwner(actor);

    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.restaurant.findUnique({ where: { code } });
    if (existing) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce code d’établissement est déjà pris.');
    }

    const restaurant = await this.prisma.restaurant.create({
      data: {
        code,
        name: dto.name.trim(),
        tagline: dto.tagline ?? '',
        description: dto.description ?? '',
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        district: dto.district ?? '',
        city: dto.city ?? 'Conakry',
        latitude: dto.latitude,
        longitude: dto.longitude,
        deliveryFee: dto.deliveryFee ?? 15_000,
        minimumOrderAmount: dto.minimumOrder ?? 50_000,
        isOpen: dto.isOpen ?? true,
      },
    });

    await this.audit.record({
      actor,
      action: 'RESTAURANT_CREATE',
      module: 'settings',
      entityType: 'Restaurant',
      entityId: restaurant.id,
      newValue: { code: restaurant.code, name: restaurant.name, city: restaurant.city },
      context,
    });

    return this.toDto(restaurant);
  }

  async update(
    id: string,
    dto: UpdateRestaurantDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    this.assertOwner(actor);

    const existing = await this.prisma.restaurant.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Établissement introuvable.');

    const restaurant = await this.prisma.restaurant.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.code ? { code: dto.code.trim().toUpperCase() } : {}),
        ...(dto.minimumOrder !== undefined ? { minimumOrderAmount: dto.minimumOrder } : {}),
      },
    });

    await this.audit.record({
      actor,
      action: 'RESTAURANT_UPDATE',
      module: 'settings',
      entityType: 'Restaurant',
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: restaurant.name, isActive: restaurant.isActive },
      context,
    });

    return this.toDto(restaurant);
  }

  /**
   * Ferme un établissement.
   *
   * Suppression logique : son chiffre d'affaires, ses dépenses et ses
   * commandes restent dans les rapports d'exercice. Fermer une adresse ne
   * réécrit pas l'histoire.
   */
  async close(id: string, actor: AuthenticatedUser, context: RequestContext) {
    this.assertOwner(actor);

    const existing = await this.prisma.restaurant.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Établissement introuvable.');

    const remaining = await this.prisma.restaurant.count({
      where: { deletedAt: null, isActive: true },
    });
    if (remaining <= 1) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Le dernier établissement ne peut pas être fermé.',
      );
    }

    await this.prisma.restaurant.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actor,
      action: 'RESTAURANT_CLOSE',
      module: 'settings',
      entityType: 'Restaurant',
      entityId: id,
      oldValue: { code: existing.code, name: existing.name },
      context,
    });

    return { success: true };
  }

  /** Ouvrir ou fermer une adresse relève du propriétaire, pas d'un gérant. */
  private assertOwner(actor: AuthenticatedUser): void {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Seul le propriétaire gère les établissements.',
      );
    }
  }

  private toDto(
    restaurant: Restaurant,
    counts?: { orders: number; staff: number; menuItems: number },
  ) {
    return {
      id: restaurant.id,
      code: restaurant.code,
      name: restaurant.name,
      tagline: restaurant.tagline,
      phone: restaurant.phone,
      email: restaurant.email,
      address: restaurant.address,
      district: restaurant.district,
      city: restaurant.city,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      isOpen: restaurant.isOpen,
      isActive: restaurant.isActive,
      deliveryFee: restaurant.deliveryFee,
      minimumOrder: restaurant.minimumOrderAmount,
      currency: restaurant.currency,
      ordersCount: counts?.orders ?? 0,
      staffCount: counts?.staff ?? 0,
      menuItemsCount: counts?.menuItems ?? 0,
      createdAt: restaurant.createdAt.toISOString(),
    };
  }
}
