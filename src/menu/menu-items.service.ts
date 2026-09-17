import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { DishAvailabilityService } from '../common/context/dish-availability.service';
import { restaurantContext } from '../common/context/restaurant-context';
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
import { STOCKOUTS_INCLUDE, toMenuItemDto, type AvailabilityView } from './menu.mapper';

const CACHE_PREFIX = 'menu:items';

const ITEM_INCLUDE = {
  category: { select: { id: true, name: true } },
  optionGroups: { include: { options: true }, orderBy: { sortOrder: 'asc' } },
  stockouts: STOCKOUTS_INCLUDE,
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
    private readonly availability: DishAvailabilityService,
  ) {}

  private get ttl(): number {
    return this.config.get<number>('cache.menuTtlSeconds') ?? 300;
  }

  /**
   * De quel point de vue lire la disponibilité.
   *
   * Le public voit l'enseigne : un plat lui reste offert tant qu'une
   * maison peut le préparer. Un gérant — ou le propriétaire qui a choisi
   * une adresse — voit sa maison. En vue d'ensemble, on lit l'interrupteur
   * global, et la liste nommée des maisons où c'est épuisé.
   */
  private async view(publicOnly: boolean): Promise<AvailabilityView> {
    if (publicOnly) return { houses: await this.availability.activeHouses() };
    return { at: restaurantContext.activeRestaurantId() };
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
    const publicOnly = options.publicOnly ?? false;
    const [where, view] = await Promise.all([
      this.buildWhere(query, publicOnly),
      this.view(publicOnly),
    ]);

    // Le catalogue public est très sollicité : on met en cache la page.
    const cacheKey = options.publicOnly
      ? `${CACHE_PREFIX}:public:${JSON.stringify({
          ...query,
          page: query.page,
          limit: query.limit,
        })}`
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

      return paginate(
        rows.map((row) => toMenuItemDto(row, view)),
        total,
        query.page,
        query.limit,
      );
    };

    if (!cacheKey) return load();
    return this.redis.remember(cacheKey, this.ttl, load);
  }

  async findOne(id: string, options: { publicOnly?: boolean } = {}) {
    const publicOnly = options.publicOnly ?? false;
    const [item, view] = await Promise.all([
      this.prisma.menuItem.findFirst({
        where: {
          id,
          deletedAt: null,
          ...(publicOnly ? { category: { isActive: true, deletedAt: null } } : {}),
        },
        include: ITEM_INCLUDE,
      }),
      this.view(publicOnly),
    ]);

    if (!item) throw AppException.notFound('Plat introuvable.');
    return toMenuItemDto(item, view);
  }

  /**
   * Sélection éditoriale de l'accueil Flutter, en une seule requête.
   *
   * La carte étant commune à toutes les maisons, la sélection l'est aussi.
   */
  async highlights() {
    return this.redis.remember(`${CACHE_PREFIX}:highlights`, this.ttl, async () => {
      const [orderable, view] = await Promise.all([this.orderableSomewhere(), this.view(true)]);
      const [popular, suggestions] = await Promise.all([
        this.prisma.menuItem.findMany({
          where: {
            deletedAt: null,
            isPopular: true,
            category: { isActive: true },
            ...orderable,
          },
          include: ITEM_INCLUDE,
          orderBy: { ordersCount: 'desc' },
          take: 10,
        }),
        this.prisma.menuItem.findMany({
          where: {
            deletedAt: null,
            isSuggestion: true,
            category: { isActive: true },
            ...orderable,
          },
          include: ITEM_INCLUDE,
          orderBy: { updatedAt: 'desc' },
          take: 10,
        }),
      ]);

      return {
        popular: popular.map((item) => toMenuItemDto(item, view)),
        suggestions: suggestions.map((item) => toMenuItemDto(item, view)),
      };
    });
  }

  /**
   * Le filtre public : à la carte, et pas épuisé partout.
   *
   * Un plat épuisé dans une seule maison reste sur la carte — la commande
   * ira ailleurs. Il n'en sort que lorsque plus aucune maison ne peut le
   * préparer.
   */
  private async orderableSomewhere(): Promise<Prisma.MenuItemWhereInput> {
    const epuisesPartout = await this.availability.soldOutEverywhere();
    return {
      isAvailable: true,
      ...(epuisesPartout.length > 0 ? { id: { notIn: epuisesPartout } } : {}),
    };
  }

  // ─────────────────────────────── Écriture ───────────────────────────────

  async create(dto: CreateMenuItemDto, actor: AuthenticatedUser, context: RequestContext) {
    await this.assertCategoryExists(dto.categoryId);
    this.assertPricing(dto.price, dto.promoPrice ?? null);

    const item = await this.prisma.transaction(async (tx) => {
      const created = await tx.menuItem.create({
        data: {
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

  /**
   * Disponible, ou épuisé.
   *
   * Le même geste n'a pas la même portée selon qui le fait :
   *
   *  • **dans une maison** — un gérant, ou le propriétaire qui a choisi
   *    une adresse — « épuisé » ne vaut que là. Les autres maisons
   *    continuent de servir le plat, et les commandes des clients proches
   *    de celle-ci basculent chez elles ;
   *  • **en vue d'ensemble**, le propriétaire retire le plat de la carte
   *    pour toute l'enseigne, ou l'y remet.
   *
   * Un plat retiré de la carte ne se remet pas depuis une maison : le
   * gérant n'a pas la main sur l'enseigne, et son geste échouerait en
   * silence — d'où le refus explicite.
   */
  async setAvailability(
    id: string,
    isAvailable: boolean,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.menuItem.findFirst({
      where: { id, deletedAt: null },
      include: { stockouts: STOCKOUTS_INCLUDE },
    });
    if (!existing) throw AppException.notFound('Plat introuvable.');

    const maison = restaurantContext.activeRestaurantId();

    if (maison) {
      if (isAvailable && !existing.isAvailable) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'Ce plat est retiré de la carte pour toute l’enseigne. Seule la vue d’ensemble peut l’y remettre.',
        );
      }

      if (isAvailable) {
        await this.prisma.menuItemStockout.deleteMany({
          where: { menuItemId: id, restaurantId: maison },
        });
      } else {
        await this.prisma.menuItemStockout.upsert({
          where: { menuItemId_restaurantId: { menuItemId: id, restaurantId: maison } },
          update: {},
          create: { menuItemId: id, restaurantId: maison },
        });
      }
    } else {
      await this.prisma.menuItem.update({ where: { id }, data: { isAvailable } });
    }

    const item = await this.prisma.menuItem.findUniqueOrThrow({
      where: { id },
      include: ITEM_INCLUDE,
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: maison ? 'MENU_ITEM_STOCKOUT' : 'MENU_ITEM_AVAILABILITY',
      module: 'menu',
      entityType: 'MenuItem',
      entityId: id,
      oldValue: {
        isAvailable: toMenuItemDto(existing, { at: maison }).isAvailable,
        ...(maison ? { restaurantId: maison } : {}),
      },
      newValue: { isAvailable, ...(maison ? { restaurantId: maison } : {}) },
      context,
    });

    return toMenuItemDto(item, { at: maison });
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
        // Jamais obligatoire, quoi que le formulaire envoie : un
        // accompagnement ne doit pas empêcher de commander le plat seul.
        isRequired: false,
        minSelect: group.minSelect ?? 0,
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
      Object.assign(where, await this.orderableSomewhere());
      where.category = { isActive: true, deletedAt: null };
    } else if (query.availability === 'available' || query.availability === 'unavailable') {
      // Dans une maison, « indisponible » couvre aussi ce qui y est
      // épuisé ; en vue d'ensemble, seul l'interrupteur global compte.
      const maison = restaurantContext.activeRestaurantId();
      const disponibleIci: Prisma.MenuItemWhereInput = {
        isAvailable: true,
        ...(maison ? { stockouts: { none: { restaurantId: maison } } } : {}),
      };
      where.AND =
        query.availability === 'available' ? [disponibleIci] : [{ NOT: disponibleIci }];
    }

    if (query.categoryId && query.categoryId !== 'all') {
      // On accepte l'identifiant ou le slug : l'application mobile
      // navigue par slug, le back-office par identifiant. Le slug est
      // unique pour toute l'enseigne, la carte étant commune.
      const category = await this.prisma.category.findFirst({
        where: {
          OR: [{ id: query.categoryId }, { slug: query.categoryId }],
        },
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
