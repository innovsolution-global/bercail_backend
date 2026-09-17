import { Injectable } from '@nestjs/common';
import { Prisma, StockCategory, StockUnit, Supplier } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import { parseEnum } from '../common/utils/wire-enum.util';
import type {
  CreateSupplierDto,
  SupplierItemDto,
  SupplierQueryDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

/** Les articles d'un fournisseur, tels que la fiche et l'achat les lisent. */
const ITEMS_INCLUDE = {
  stockItems: {
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, unit: true, category: true, isActive: true },
  },
} satisfies Prisma.SupplierInclude;

type SupplierWithItems = Supplier & {
  stockItems?: { id: string; name: string; unit: StockUnit; category: StockCategory; isActive: boolean }[];
};

/**
 * Fournisseurs du restaurant.
 *
 * Un fournisseur n'est jamais supprimé physiquement : ses achats passés
 * doivent rester lisibles dans le journal, sans quoi le rapport d'un mois
 * clos changerait après coup.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: RestaurantScopeService,
  ) {}

  async list(query: SupplierQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.SupplierWhereInput = { deletedAt: null };

    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { contactName: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
        { speciality: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: query.skip,
        take: query.take,
        include: { _count: { select: { purchases: true } }, ...ITEMS_INCLUDE },
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row, row._count.purchases)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Liste courte pour alimenter les sélecteurs des formulaires. */
  async options() {
    const suppliers = await this.prisma.supplier.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, speciality: true, phone: true },
      take: 200,
    });
    return suppliers;
  }

  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, deletedAt: null },
      include: ITEMS_INCLUDE,
    });
    if (!supplier) throw AppException.notFound('Fournisseur introuvable.');

    const [purchases, totals] = await Promise.all([
      this.prisma.purchase.findMany({
        where: { supplierId: id, deletedAt: null },
        orderBy: { purchasedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          reference: true,
          purchasedAt: true,
          totalAmount: true,
          status: true,
        },
      }),
      this.prisma.purchase.aggregate({
        where: { supplierId: id, deletedAt: null },
        _sum: { totalAmount: true },
        _count: true,
      }),
    ]);

    return {
      ...this.toDto(supplier, totals._count),
      totalPurchased: totals._sum.totalAmount ?? 0,
      recentPurchases: purchases.map((purchase) => ({
        id: purchase.id,
        reference: purchase.reference,
        purchasedAt: purchase.purchasedAt.toISOString(),
        totalAmount: purchase.totalAmount,
        status: purchase.status.toLowerCase(),
      })),
    };
  }

  async create(dto: CreateSupplierDto, actor: AuthenticatedUser, context: RequestContext) {
    const name = dto.name.trim();

    const existing = await this.prisma.supplier.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    });
    if (existing) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce fournisseur existe déjà.');
    }

    const restaurantId = this.scope.resolve(dto.restaurantId);

    // Le fournisseur et ses articles ensemble : un fournisseur créé sans
    // ses articles, parce que le second appel a échoué, serait « vide » à
    // l'achat — exactement ce qu'on corrige.
    const supplier = await this.prisma.transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: {
          restaurantId,
          name,
          contactName: dto.contactName ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address: dto.address ?? null,
          speciality: dto.speciality ?? null,
          note: dto.note ?? null,
          isActive: dto.isActive ?? true,
        },
      });

      await this.attachItems(tx, created.id, restaurantId, dto.items ?? []);

      return tx.supplier.findUniqueOrThrow({ where: { id: created.id }, include: ITEMS_INCLUDE });
    });

    await this.audit.record({
      actor,
      action: 'SUPPLIER_CREATE',
      module: 'stock',
      entityType: 'Supplier',
      entityId: supplier.id,
      newValue: {
        name: supplier.name,
        speciality: supplier.speciality,
        items: supplier.stockItems.map((item) => item.name),
      },
      context,
    });

    return this.toDto(supplier);
  }

  /**
   * Met les articles livrés dans le stock de la maison, au nom du fournisseur.
   *
   * Un article qui existe déjà dans ce stock sous le même nom n'est pas
   * dupliqué : il est rattaché au fournisseur. Deux « Pomme » dans la
   * réserve, l'un avec fournisseur et l'autre sans, rendraient l'inventaire
   * faux.
   */
  private async attachItems(
    tx: Prisma.TransactionClient,
    supplierId: string,
    restaurantId: string,
    items: SupplierItemDto[],
  ): Promise<void> {
    const vus = new Set<string>();

    for (const item of items) {
      const nom = item.name.trim();
      const cle = nom.toLowerCase();
      if (!nom || vus.has(cle)) continue;
      vus.add(cle);

      const existant = await tx.stockItem.findFirst({
        where: { restaurantId, deletedAt: null, name: { equals: nom, mode: 'insensitive' } },
        select: { id: true },
      });

      if (existant) {
        await tx.stockItem.update({ where: { id: existant.id }, data: { supplierId } });
        continue;
      }

      await tx.stockItem.create({
        data: {
          restaurantId,
          supplierId,
          name: nom,
          category: (parseEnum(StockCategory, item.category) ?? StockCategory.AUTRE) as StockCategory,
          unit: (parseEnum(StockUnit, item.unit) ?? StockUnit.KG) as StockUnit,
          quantity: 0,
          minQuantity: 0,
          averageCost: 0,
        },
      });
    }
  }

  async update(
    id: string,
    dto: UpdateSupplierDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Fournisseur introuvable.');

    const supplier = await this.prisma.transaction(async (tx) => {
      await tx.supplier.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          contactName: dto.contactName,
          phone: dto.phone,
          email: dto.email,
          address: dto.address,
          speciality: dto.speciality,
          note: dto.note,
          isActive: dto.isActive,
        },
      });

      await this.attachItems(tx, id, existing.restaurantId, dto.items ?? []);

      return tx.supplier.findUniqueOrThrow({ where: { id }, include: ITEMS_INCLUDE });
    });

    await this.audit.record({
      actor,
      action: 'SUPPLIER_UPDATE',
      module: 'stock',
      entityType: 'Supplier',
      entityId: id,
      oldValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: supplier.name, isActive: supplier.isActive },
      context,
    });

    return this.toDto(supplier);
  }

  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Fournisseur introuvable.');

    await this.prisma.supplier.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actor,
      action: 'SUPPLIER_DELETE',
      module: 'stock',
      entityType: 'Supplier',
      entityId: id,
      oldValue: { name: existing.name },
      context,
    });

    return { success: true };
  }

  private toDto(supplier: SupplierWithItems, purchasesCount?: number) {
    return {
      id: supplier.id,
      name: supplier.name,
      contactName: supplier.contactName,
      phone: supplier.phone,
      email: supplier.email,
      address: supplier.address,
      speciality: supplier.speciality,
      note: supplier.note,
      isActive: supplier.isActive,
      purchasesCount: purchasesCount ?? 0,
      /** Les articles de stock qu'il livre — ceux qu'un achat lui prendra. */
      items: (supplier.stockItems ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        unit: item.unit.toLowerCase(),
        category: item.category.toLowerCase(),
        isActive: item.isActive,
      })),
      createdAt: supplier.createdAt.toISOString(),
    };
  }
}
