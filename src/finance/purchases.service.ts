import { Injectable } from '@nestjs/common';
import {
  ExpenseCategory,
  ExpenseStatus,
  FinancePaymentMethod,
  Prisma,
  StockMovementReason,
  StockMovementType,
  StockUnit,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { generateDocumentReference } from '../common/utils/reference.util';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import type {
  CancelPurchaseDto,
  CreatePurchaseDto,
  PurchaseQueryDto,
  SettlePurchaseDto,
} from './dto/purchase.dto';
import { StockService } from './stock.service';

const PURCHASE_INCLUDE = {
  supplier: { select: { id: true, name: true, phone: true } },
  items: { include: { stockItem: { select: { id: true, name: true } } } },
  createdBy: { select: { firstName: true, lastName: true } },
  expense: { select: { id: true, reference: true, status: true } },
} satisfies Prisma.PurchaseInclude;

type PurchaseRow = Prisma.PurchaseGetPayload<{ include: typeof PURCHASE_INCLUDE }>;

/**
 * Approvisionnements.
 *
 * Un achat est le point où les trois registres se rejoignent : il entre la
 * marchandise en stock, il inscrit la sortie d'argent au journal, et il
 * garde la facture du fournisseur. Les trois écritures sont faites dans la
 * même transaction — il ne peut pas y avoir de poulet en stock sans la
 * dépense qui l'a payé.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly scope: RestaurantScopeService,
  ) {}

  async list(query: PurchaseQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.PurchaseWhereInput = { deletedAt: null };

    if (query.supplierId && query.supplierId !== 'all') where.supplierId = query.supplierId;

    const status = parseEnum(ExpenseStatus, query.status);
    if (status) where.status = status;

    if (query.from || query.to) {
      where.purchasedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { reference: { contains: query.search, mode: 'insensitive' } },
        { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
        { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
        { items: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
      ];
    }

    const [rows, total, sum] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        orderBy: { purchasedAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
        include: PURCHASE_INCLUDE,
      }),
      this.prisma.purchase.count({ where }),
      this.prisma.purchase.aggregate({ where, _sum: { totalAmount: true } }),
    ]);

    const result = paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);

    return {
      ...result,
      meta: { ...result.meta, totalAmount: sum._sum.totalAmount ?? 0 },
    } as PaginatedResult<unknown>;
  }

  async findOne(id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, deletedAt: null },
      include: PURCHASE_INCLUDE,
    });
    if (!purchase) throw AppException.notFound('Approvisionnement introuvable.');
    return this.toDto(purchase);
  }

  /**
   * Enregistre un achat.
   *
   * Les montants ne sont pas repris tels quels du client : chaque ligne est
   * recalculée (quantité × prix unitaire) et le total est la somme des
   * lignes. Le fournisseur peut annoncer ce qu'il veut, le journal, lui,
   * reste cohérent.
   */
  async create(dto: CreatePurchaseDto, actor: AuthenticatedUser, context: RequestContext) {
    const restaurantId = this.scope.resolve(dto.restaurantId);
    const purchasedAt = dto.purchasedAt ? new Date(dto.purchasedAt) : new Date();
    const status = dto.status === 'pending' ? ExpenseStatus.PENDING : ExpenseStatus.PAID;
    const paymentMethod = (parseEnum(FinancePaymentMethod, dto.paymentMethod) ??
      FinancePaymentMethod.CASH) as FinancePaymentMethod;

    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: dto.supplierId, deletedAt: null },
      });
      if (!supplier) throw AppException.badRequest(ERROR_CODES.NOT_FOUND, 'Fournisseur introuvable.');
    }

    // Les articles référencés sont relus en base : leur nom et leur unité
    // font foi, pas ceux envoyés par le formulaire.
    const stockItemIds = dto.items
      .map((line) => line.stockItemId)
      .filter((value): value is string => Boolean(value));

    const stockItems = stockItemIds.length
      ? await this.prisma.stockItem.findMany({
          where: { id: { in: stockItemIds }, deletedAt: null },
        })
      : [];
    const stockItemById = new Map(stockItems.map((item) => [item.id, item]));

    const lines = dto.items.map((line) => {
      const stockItem = line.stockItemId ? stockItemById.get(line.stockItemId) : undefined;

      if (line.stockItemId && !stockItem) {
        throw AppException.badRequest(
          ERROR_CODES.NOT_FOUND,
          'Un article de cet achat n’existe plus dans le stock.',
          { stockItemId: line.stockItemId },
        );
      }

      const name = stockItem?.name ?? line.name?.trim();
      if (!name) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'Chaque ligne doit désigner un article du stock ou porter un libellé.',
        );
      }

      const quantity = Math.round(line.quantity * 1000) / 1000;
      return {
        stockItemId: stockItem?.id ?? null,
        name,
        unit: (stockItem?.unit ?? parseEnum(StockUnit, line.unit) ?? StockUnit.KG) as StockUnit,
        quantity,
        unitPrice: Math.round(line.unitPrice),
        lineTotal: Math.round(quantity * line.unitPrice),
      };
    });

    const totalAmount = lines.reduce((total, line) => total + line.lineTotal, 0);

    if (totalAmount <= 0) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Le montant total de l’achat doit être supérieur à zéro.',
      );
    }

    const created = await this.prisma.transaction(async (tx) => {
      const purchase = await tx.purchase.create({
        data: {
          restaurantId,
          reference: generateDocumentReference('ACH', purchasedAt),
          supplierId: dto.supplierId ?? null,
          purchasedAt,
          totalAmount,
          paymentMethod,
          status,
          invoiceNumber: dto.invoiceNumber ?? null,
          note: dto.note ?? null,
          createdById: actor.id,
          items: { create: lines },
        },
        include: PURCHASE_INCLUDE,
      });

      // Entrée en stock, ligne par ligne : le coût moyen pondéré de chaque
      // article se met à jour au passage.
      for (const line of lines) {
        if (!line.stockItemId) continue;
        await this.stock.applyMovement(tx, {
          stockItemId: line.stockItemId,
          type: StockMovementType.IN,
          reason: StockMovementReason.PURCHASE,
          quantity: line.quantity,
          unitCost: line.unitPrice,
          occurredAt: purchasedAt,
          note: `Achat ${purchase.reference}`,
          purchaseId: purchase.id,
          createdById: actor.id,
        });
      }

      // La dépense correspondante, dans la même transaction.
      await tx.expense.create({
        data: {
          // La dépense naît de l'achat : même établissement, forcément.
          restaurantId: purchase.restaurantId,
          reference: generateDocumentReference('DEP', purchasedAt),
          label: `Approvisionnement ${purchase.reference}`,
          category: ExpenseCategory.INGREDIENTS,
          amount: totalAmount,
          status,
          paymentMethod,
          incurredAt: purchasedAt,
          paidAt: status === ExpenseStatus.PAID ? purchasedAt : null,
          supplierId: dto.supplierId ?? null,
          purchaseId: purchase.id,
          invoiceNumber: dto.invoiceNumber ?? null,
          createdById: actor.id,
        },
      });

      return tx.purchase.findUniqueOrThrow({
        where: { id: purchase.id },
        include: PURCHASE_INCLUDE,
      });
    });

    await this.audit.record({
      actor,
      action: 'PURCHASE_CREATE',
      module: 'stock',
      entityType: 'Purchase',
      entityId: created.id,
      newValue: {
        reference: created.reference,
        totalAmount,
        lines: lines.length,
        supplierId: dto.supplierId ?? null,
      },
      context,
    });

    return this.toDto(created);
  }

  /** Règle un achat resté à crédit. */
  async settle(
    id: string,
    dto: SettlePurchaseDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.purchase.findFirst({
      where: { id, deletedAt: null },
      include: { expense: true },
    });
    if (!existing) throw AppException.notFound('Approvisionnement introuvable.');

    if (existing.status === ExpenseStatus.PAID) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Cet achat est déjà réglé.');
    }
    if (existing.status === ExpenseStatus.CANCELLED) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Cet achat a été annulé.');
    }

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    const paymentMethod = parseEnum(FinancePaymentMethod, dto.paymentMethod);

    const updated = await this.prisma.transaction(async (tx) => {
      if (existing.expense) {
        await tx.expense.update({
          where: { id: existing.expense.id },
          data: { status: ExpenseStatus.PAID, paidAt, paymentMethod },
        });
      }

      return tx.purchase.update({
        where: { id },
        data: { status: ExpenseStatus.PAID, paymentMethod },
        include: PURCHASE_INCLUDE,
      });
    });

    await this.audit.record({
      actor,
      action: 'PURCHASE_SETTLE',
      module: 'stock',
      entityType: 'Purchase',
      entityId: id,
      newValue: { reference: existing.reference, amount: existing.totalAmount },
      context,
    });

    return this.toDto(updated);
  }

  /**
   * Annule un achat : la marchandise ressort du stock et la dépense
   * disparaît du journal. Le document, lui, reste consultable — annuler
   * n'est pas effacer.
   */
  async cancel(
    id: string,
    dto: CancelPurchaseDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.purchase.findFirst({
      where: { id, deletedAt: null },
      include: { items: true, expense: true },
    });
    if (!existing) throw AppException.notFound('Approvisionnement introuvable.');

    if (existing.status === ExpenseStatus.CANCELLED) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Cet achat est déjà annulé.');
    }

    await this.prisma.transaction(async (tx) => {
      for (const item of existing.items) {
        if (!item.stockItemId) continue;

        // La marchandise a pu être consommée depuis : on ne ressort que ce
        // qui reste. Refuser l'annulation pour cette raison laisserait une
        // fausse facture dans le journal, ce qui est pire.
        const stockItem = await tx.stockItem.findUnique({ where: { id: item.stockItemId } });
        const quantity = Math.min(item.quantity, stockItem?.quantity ?? 0);
        if (quantity <= 0) continue;

        await this.stock.applyMovement(tx, {
          stockItemId: item.stockItemId,
          type: StockMovementType.OUT,
          reason: StockMovementReason.RETURN,
          quantity,
          unitCost: item.unitPrice,
          note: `Annulation de l’achat ${existing.reference}`,
          purchaseId: existing.id,
          createdById: actor.id,
        });
      }

      if (existing.expense) {
        await tx.expense.update({
          where: { id: existing.expense.id },
          data: { status: ExpenseStatus.CANCELLED, deletedAt: new Date(), note: dto.reason },
        });
      }

      await tx.purchase.update({
        where: { id },
        data: { status: ExpenseStatus.CANCELLED, note: dto.reason },
      });
    });

    await this.audit.record({
      actor,
      action: 'PURCHASE_CANCEL',
      module: 'stock',
      entityType: 'Purchase',
      entityId: id,
      oldValue: { reference: existing.reference, totalAmount: existing.totalAmount },
      newValue: { reason: dto.reason },
      context,
    });

    return this.findOne(id);
  }

  private toDto(purchase: PurchaseRow) {
    return {
      id: purchase.id,
      reference: purchase.reference,
      supplierId: purchase.supplierId,
      supplierName: purchase.supplier?.name ?? null,
      supplierPhone: purchase.supplier?.phone ?? null,
      purchasedAt: purchase.purchasedAt.toISOString(),
      totalAmount: purchase.totalAmount,
      paymentMethod: toWire(purchase.paymentMethod),
      status: toWire(purchase.status),
      invoiceNumber: purchase.invoiceNumber,
      note: purchase.note,
      expenseId: purchase.expense?.id ?? null,
      itemsCount: purchase.items.length,
      items: purchase.items.map((item) => ({
        id: item.id,
        stockItemId: item.stockItemId,
        name: item.name,
        unit: toWire(item.unit),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
      authorName: purchase.createdBy
        ? `${purchase.createdBy.firstName} ${purchase.createdBy.lastName}`.trim()
        : null,
      createdAt: purchase.createdAt.toISOString(),
    };
  }
}
