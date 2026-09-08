import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import type {
  CreateMenuItemDto,
  MenuItemQueryDto,
  MenuOptionGroupInputDto,
  UpdateMenuItemDto,
} from './dto/menu.dto';
import { toMenuItemDto } from './menu.mapper';

const CACHE_PREFIX = 'menu:items';

const ITEM_INCLUDE = {
  category: { select: { id: true, name: true } },
  optionGroups: { include: { options: true }, orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.MenuItemInclude;

/**
 * Carte du restaurant.
 *
 * Un seul service pour les deux publics : Flutter consulte, React édite.
 * La différence tient au filtre appliqué (`publicOnly`) et aux permissions
 * exigées par le contrôleur — pas à une logique métier dupliquée.
 */
@Injectable()
export class MenuItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly scope: RestaurantScopeService,
  ) {}

  private get ttl(): number {
    return this.config.get<number>('cache.menuTtlSeconds') ?? 300;
  }

  private async invalidate(): Promise<void> {
    await this.redis.delByPattern(`${CACHE_PREFIX}*`);
    await this.redis.delByPattern('menu:categories*');
  }

  // ─────────────────────────────── Lecture ────────────────────────────────

  async list(
    query: MenuItemQueryDto,
    options: { publicOnly?: boolean } = {},
  ): Promise<PaginatedResult<ReturnType<typeof toMenuItemDto>>> {
    const where = await this.buildWhere(query, options.publicOnly ?? false);

    // Le catalogue public est très sollicité : on met en cache la page.
    const cacheKey = options.publicOnly
      ? `${CACHE_PREFIX}:public:${JSON.stringify({ ...query, page: query.page, limit: query.limit })}`
      : null;

    const load = async () => {
      const [rows, total] = await Promise.all([
        this.prisma.menuItem.findMany({
          where,
          include: ITEM_INCLUDE,
          orderBy: this.buildOrder(query),
          skip: query.skip,
          take: query.take,
        }),
        this.prisma.menuItem.count({ where }),
      ]);

      return paginate(rows.map(toMenuItemDto), total, query.page, query.limit);
    };

    if (!cacheKey) return load();
    return this.redis.remember(cacheKey, this.ttl, load);
  }

  async findOne(id: string, options: { publicOnly?: boolean } = {}) {
    const item = await this.prisma.menuItem.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(options.publicOnly ? { category: { isActive: true, deletedAt: null } } : {}),
      },
      include: ITEM_INCLUDE,
    });

    if (!item) throw AppException.notFound('Plat introuvable.');
    return toMenuItemDto(item);
  }

  /** Sélection éditoriale de l'accueil Flutter, en une seule requête. */
  async highlights() {
    return this.redis.remember(`${CACHE_PREFIX}:highlights`, this.ttl, async () => {
      const [popular, suggestions] = await Promise.all([
        this.prisma.menuItem.findMany({
          where: { deletedAt: null, isAvailable: true, isPopular: true, category: { isActive: true } },
          include: ITEM_INCLUDE,
          orderBy: { ordersCount: 'desc' },
          take: 10,
        }),
        this.prisma.menuItem.findMany({
          where: {
            deletedAt: null,
            isAvailable: true,
            isSuggestion: true,
            category: { isActive: true },
          },
          include: ITEM_INCLUDE,
          orderBy: { updatedAt: 'desc' },
          take: 10,
        }),
      ]);

      return {
        popular: popular.map(toMenuItemDto),
        suggestions: suggestions.map(toMenuItemDto),
      };
    });
  }

  // ─────────────────────────────── Écriture ───────────────────────────────

  async create(dto: CreateMenuItemDto, actor: AuthenticatedUser, context: RequestContext) {
    await this.assertCategoryExists(dto.categoryId);
    this.assertPricing(dto.price, dto.promoPrice ?? null);

    const item = await this.prisma.transaction(async (tx) => {
      const created = await tx.menuItem.create({
        data: {
          restaurantId: this.scope.resolve(dto.restaurantId),
          categoryId: dto.categoryId,
          name: dto.name,
          shortDescription: dto.shortDescription ?? '',
          description: dto.description ?? '',
          price: dto.price,
          promoPrice: dto.promoPrice ?? null,
          imageUrl: dto.imageUrl ?? '',
          ingredients: dto.ingredients ?? [],
          isAvailable: dto.isAvailable ?? true,
          isPopular: dto.isPopular ?? false,
          isSuggestion: dto.isSuggestion ?? false,
          isSpicy: dto.isSpicy ?? false,
          preparationMinutes: dto.preparationMinutes ?? 20,
        },
      });

      if (dto.optionGroups?.length) {
        await this.writeOptionGroups(tx, created.id, dto.optionGroups);
      }

      return tx.menuItem.findUniqueOrThrow({ where: { id: created.id }, include: ITEM_INCLUDE });
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: 'MENU_ITEM_CREATE',
      module: 'menu',
      entityType: 'MenuItem',
      entityId: item.id,
      newValue: { name: item.name, price: item.price, categoryId: item.categoryId },
      context,
    });

    return toMenuItemDto(item);
  }

  async update(
    id: string,
    dto: UpdateMenuItemDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.menuItem.findFirst({
      where: { id, deletedAt: null },
      include: ITEM_INCLUDE,
    });
    if (!existing) throw AppException.notFound('Plat introuvable.');

    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    const price = dto.price ?? existing.price;
    const promoPrice = dto.promoPrice === undefined ? existing.promoPrice : dto.promoPrice;
    this.assertPricing(price, promoPrice);

    const { optionGroups, ...scalars } = dto;

    const item = await this.prisma.transaction(async (tx) => {
      await tx.menuItem.update({
        where: { id },
        data: {
          ...scalars,
          ...(dto.promoPrice === undefined ? {} : { promoPrice: dto.promoPrice }),
        },
      });

      if (optionGroups) {
        await this.writeOptionGroups(tx, id, optionGroups, { replace: true });
      }

      return tx.menuItem.findUniqueOrThrow({ where: { id }, include: ITEM_INCLUDE });
    });

    await this.invalidate();

    // Un changement de prix est une action sensible : on garde l'avant/après.
    await this.audit.record({
      actor,
      action: existing.price !== item.price ? 'MENU_ITEM_PRICE_UPDATE' : 'MENU_ITEM_UPDATE',
      module: 'menu',
      entityType: 'MenuItem',
      entityId: id,
      oldValue: {
        name: existing.name,
        price: existing.price,
        promoPrice: existing.promoPrice,
        isAvailable: existing.isAvailable,
        categoryId: existing.categoryId,
      },
      newValue: {
        name: item.name,
        price: item.price,
        promoPrice: item.promoPrice,
        isAvailable: item.isAvailable,
        categoryId: item.categoryId,
      },
      context,
    });

    return toMenuItemDto(item);
  }

  async setAvailability(
    id: string,
    isAvailable: boolean,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Plat introuvable.');

    const item = await this.prisma.menuItem.update({
      where: { id },
      data: { isAvailable },
      include: ITEM_INCLUDE,
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: 'MENU_ITEM_AVAILABILITY',
      module: 'menu',
      entityType: 'MenuItem',
      entityId: id,
      oldValue: { isAvailable: existing.isAvailable },
      newValue: { isAvailable },
      context,
    });

    return toMenuItemDto(item);
  }

  /**
   * Suppression logique.
   * Les commandes passées gardent le nom et le prix d'origine : elles ne
   * dépendent pas de la ligne de carte, qui peut disparaître.
   */
  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Plat introuvable.');

    await this.prisma.transaction(async (tx) => {
      await tx.menuItem.update({
        where: { id },
        data: { deletedAt: new Date(), isAvailable: false },
      });
      // Le plat sort aussi des paniers en cours : personne ne doit
      // commander un plat retiré de la carte.
      await tx.cartItem.deleteMany({ where: { menuItemId: id } });
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: 'MENU_ITEM_DELETE',
      module: 'menu',
      entityType: 'MenuItem',
      entityId: id,
      oldValue: { name: existing.name, price: existing.price },
      context,
    });

    return { success: true };
  }

  // ──────────────────────────────── Outils ────────────────────────────────

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, deletedAt: null },
      select: { id: true },
    });
    if (!category) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_ERROR, 'Catégorie inconnue.');
    }
  }

  /** Un prix promotionnel supérieur au prix normal n'a aucun sens. */
  private assertPricing(price: number, promoPrice: number | null): void {
    if (promoPrice !== null && promoPrice >= price) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Le prix promotionnel doit être inférieur au prix normal.',
      );
    }
  }

  /**
   * Écriture des groupes d'options.
   * En mise à jour, les groupes absents du corps sont supprimés : le
   * back-office envoie toujours l'état complet souhaité.
   */
  private async writeOptionGroups(
    tx: Prisma.TransactionClient,
    menuItemId: string,
    groups: MenuOptionGroupInputDto[],
    options: { replace?: boolean } = {},
  ): Promise<void> {
    if (options.replace) {
      const keptIds = groups.map((group) => group.id).filter((id): id is string => Boolean(id));
      await tx.menuOptionGroup.deleteMany({
        where: { menuItemId, ...(keptIds.length > 0 ? { id: { notIn: keptIds } } : {}) },
      });
    }

    for (const [groupIndex, group] of groups.entries()) {
      if (group.maxSelect !== undefined && group.minSelect !== undefined) {
        if (group.maxSelect < group.minSelect) {
          throw AppException.badRequest(
            ERROR_CODES.VALIDATION_ERROR,
            `Groupe « ${group.name} » : maxSelect ne peut pas être inférieur à minSelect.`,
          );
        }
      }

      const data = {
        menuItemId,
        name: group.name,
        isRequired: group.isRequired ?? false,
        minSelect: group.minSelect ?? (group.isRequired ? 1 : 0),
        maxSelect: group.maxSelect ?? 1,
        sortOrder: group.sortOrder ?? groupIndex,
      };

      const saved = group.id
        ? await tx.menuOptionGroup.update({ where: { id: group.id }, data })
        : await tx.menuOptionGroup.create({ data });

      const keptOptionIds = group.options
        .map((option) => option.id)
        .filter((id): id is string => Boolean(id));

      await tx.menuOption.deleteMany({
        where: {
          groupId: saved.id,
          ...(keptOptionIds.length > 0 ? { id: { notIn: keptOptionIds } } : {}),
        },
      });

      for (const [optionIndex, option] of group.options.entries()) {
        const optionData = {
          groupId: saved.id,
          name: option.name,
          extraPrice: option.extraPrice,
          isAvailable: option.isAvailable ?? true,
          sortOrder: option.sortOrder ?? optionIndex,
        };

        if (option.id) {
          await tx.menuOption.update({ where: { id: option.id }, data: optionData });
        } else {
          await tx.menuOption.create({ data: optionData });
        }
      }
    }
  }

  private async buildWhere(
    query: MenuItemQueryDto,
    publicOnly: boolean,
  ): Promise<Prisma.MenuItemWhereInput> {
    const where: Prisma.MenuItemWhereInput = { deletedAt: null };

    if (publicOnly) {
      where.isAvailable = true;
      where.category = { isActive: true, deletedAt: null };
    } else if (query.availability === 'available') {
      where.isAvailable = true;
    } else if (query.availability === 'unavailable') {
      where.isAvailable = false;
    }

    if (query.categoryId && query.categoryId !== 'all') {
      // On accepte l'identifiant ou le slug : l'application mobile
      // navigue par slug, le back-office par identifiant.
      const category = await this.prisma.category.findFirst({
        where: { OR: [{ id: query.categoryId }, { slug: query.categoryId }] },
        select: { id: true },
      });
      where.categoryId = category?.id ?? query.categoryId;
    }

    if (query.popular) where.isPopular = true;
    if (query.suggestion) where.isSuggestion = true;

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.price = {
        ...(query.minPrice !== undefined ? { gte: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { lte: query.maxPrice } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { shortDescription: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { ingredients: { has: query.search } },
      ];
    }

    return where;
  }

  private buildOrder(query: MenuItemQueryDto): Prisma.MenuItemOrderByWithRelationInput[] {
    const direction = query.sortOrder ?? 'desc';

    switch (query.sortBy) {
      case 'price':
        return [{ price: direction }];
      case 'name':
        return [{ name: query.sortOrder ?? 'asc' }];
      case 'popularity':
        return [{ ordersCount: 'desc' }, { name: 'asc' }];
      case 'createdAt':
        return [{ createdAt: direction }];
      default:
        return [{ isPopular: 'desc' }, { ordersCount: 'desc' }, { name: 'asc' }];
    }
  }
}
