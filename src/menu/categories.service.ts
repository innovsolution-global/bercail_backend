import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { slugify } from '../common/utils/reference.util';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/menu.dto';
import { toCategoryDto } from './menu.mapper';

const CACHE_PREFIX = 'menu:categories';

/**
 * Catégories de la carte.
 *
 * Lecture massivement mise en cache (l'écran d'accueil Flutter les
 * demande à chaque ouverture), invalidée à la moindre écriture.
 */
@Injectable()
export class CategoriesService {
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
    await this.redis.delByPattern('menu:items*');
  }

  /**
   * La carte est **commune à toutes les maisons** : le client et le
   * back-office lisent les mêmes catégories, d'où une seule clé de cache.
   *
   * @param _publicOnly Conservé pour les appelants ; il ne change plus le
   *   périmètre depuis que la carte n'appartient à aucun établissement.
   */
  async list(includeInactive = false, _publicOnly = false) {
    const cacheKey = `${CACHE_PREFIX}:${includeInactive ? 'all' : 'active'}`;

    return this.redis.remember(cacheKey, this.ttl, async () => {
      const categories = await this.prisma.category.findMany({
        where: {
          deletedAt: null,
          ...(includeInactive ? {} : { isActive: true }),
        },
        include: {
          _count: {
            select: { menuItems: { where: { deletedAt: null } } },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });

      return categories.map(toCategoryDto);
    });
  }

  async findOne(id: string, _publicOnly = false) {
    // Le slug est unique pour toute l'enseigne : une seule « grillades ».
    const category = await this.prisma.category.findFirst({
      where: {
        OR: [{ id }, { slug: id }],
        deletedAt: null,
      },
      include: { _count: { select: { menuItems: { where: { deletedAt: null } } } } },
    });

    if (!category) throw AppException.notFound('Catégorie introuvable.');
    return toCategoryDto(category);
  }

  async create(dto: CreateCategoryDto, actor: AuthenticatedUser, context: RequestContext) {
    const slug = await this.uniqueSlug(dto.name);

    const category = await this.prisma.category.create({
      data: {
        name: dto.name,
        slug,
        emoji: dto.emoji,
        description: dto.description,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
      include: { _count: { select: { menuItems: true } } },
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: 'CATEGORY_CREATE',
      module: 'menu',
      entityType: 'Category',
      entityId: category.id,
      newValue: { name: category.name, slug: category.slug },
      context,
    });

    return toCategoryDto(category);
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Catégorie introuvable.');

    const category = await this.prisma.category.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.name && dto.name !== existing.name
          ? { slug: await this.uniqueSlug(dto.name, id) }
          : {}),
      },
      include: { _count: { select: { menuItems: { where: { deletedAt: null } } } } },
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: 'CATEGORY_UPDATE',
      module: 'menu',
      entityType: 'Category',
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive, sortOrder: existing.sortOrder },
      newValue: { name: category.name, isActive: category.isActive, sortOrder: category.sortOrder },
      context,
    });

    return toCategoryDto(category);
  }

  /**
   * Suppression logique.
   *
   * Une catégorie qui contient encore des plats actifs n'est pas
   * supprimable : la carte deviendrait incohérente pour les clients.
   */
  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const category = await this.prisma.category.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { menuItems: { where: { deletedAt: null } } } } },
    });

    if (!category) throw AppException.notFound('Catégorie introuvable.');

    if (category._count.menuItems > 0) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        `Cette catégorie contient encore ${category._count.menuItems} plat(s). Déplacez-les ou supprimez-les d'abord.`,
      );
    }

    await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.invalidate();
    await this.audit.record({
      actor,
      action: 'CATEGORY_DELETE',
      module: 'menu',
      entityType: 'Category',
      entityId: id,
      oldValue: { name: category.name },
      context,
    });

    return { success: true };
  }

  /** Slug unique, y compris après renommage. */
  private async uniqueSlug(name: string, excludeId?: string): Promise<string> {
    const base = slugify(name) || 'categorie';
    let candidate = base;
    let suffix = 2;

    for (;;) {
      const conflict = await this.prisma.category.findFirst({
        where: { slug: candidate, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
        select: { id: true },
      });
      if (!conflict) return candidate;
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
  }
}
