import { Injectable } from '@nestjs/common';
import { Prisma, Supplier } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import type {
  CreateSupplierDto,
  SupplierQueryDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

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
        include: { _count: { select: { purchases: true } } },
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
    const supplier = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } });
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

    const supplier = await this.prisma.supplier.create({
      data: {
        restaurantId: this.scope.resolve(dto.restaurantId),
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

    await this.audit.record({
      actor,
      action: 'SUPPLIER_CREATE',
      module: 'stock',
      entityType: 'Supplier',
      entityId: supplier.id,
      newValue: { name: supplier.name, speciality: supplier.speciality },
      context,
    });

    return this.toDto(supplier);
  }

  async update(
    id: string,
    dto: UpdateSupplierDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Fournisseur introuvable.');

    const supplier = await this.prisma.supplier.update({
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

  private toDto(supplier: Supplier, purchasesCount?: number) {
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
      createdAt: supplier.createdAt.toISOString(),
    };
  }
}
