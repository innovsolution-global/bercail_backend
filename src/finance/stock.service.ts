import { Injectable } from '@nestjs/common';
import {
  Prisma,
  StockCategory,
  StockItem,
  StockMovementReason,
  StockMovementType,
  StockUnit,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { restaurantFilter } from '../common/context/restaurant-sql';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import type {
  CreateStockItemDto,
  CreateStockMovementDto,
  StockItemQueryDto,
  StockMovementQueryDto,
  UpdateStockItemDto,
} from './dto/stock.dto';

/** Entrée du journal de stock, telle qu'appliquée dans une transaction. */
export interface MovementInput {
  stockItemId: string;
  type: StockMovementType;
  reason: StockMovementReason;
  /** Quantité du mouvement ; pour un ajustement, le stock réellement compté. */
  quantity: number;
  unitCost?: number;
  occurredAt?: Date;
  note?: string | null;
  purchaseId?: string | null;
  createdById?: string | null;
  /**
   * Autorise le stock à passer sous zéro.
   *
   * Réservé à la sortie automatique déclenchée par une vente : refuser
   * parce que le compteur annonce zéro reviendrait à nier une vente qui a
   * eu lieu. Une saisie humaine, elle, reste refusée — c'est une faute de
   * frappe bien plus souvent qu'un stock réellement négatif.
   */
  allowNegative?: boolean;
}

/** Les quantités sont décimales : on arrondit au gramme / au millilitre près. */
function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Stock et journal des mouvements.
 *
 * Le stock n'est jamais écrit directement : il est la conséquence d'un
 * mouvement. Chaque entrée recalcule le coût moyen pondéré, qui sert
 * ensuite à valoriser les sorties de cuisine et le stock restant — c'est
 * ce chiffre qui répond à « combien vaut ce qu'il y a dans la réserve ? ».
 */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: RestaurantScopeService,
  ) {}

  // ─────────────────────────────── Articles ───────────────────────────────

  async listItems(query: StockItemQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.StockItemWhereInput = { deletedAt: null };

    const category = parseEnum(StockCategory, query.category);
    if (category) where.category = category;

    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.supplierId && query.supplierId !== 'all') where.supplierId = query.supplierId;

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.level === 'out') where.quantity = { lte: 0 };

    // Le seuil d'alerte compare deux colonnes, ce que le `where` de Prisma
    // ne sait pas exprimer. On résout donc les identifiants concernés en
    // base plutôt qu'en filtrant la page déjà lue : sinon la pagination et
    // le total mentiraient tous les deux.
    if (query.level === 'low' || query.level === 'ok') {
      where.id = { in: await this.idsByLevel(query.level) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.stockItem.findMany({
        where,
        orderBy: query.sortBy === 'quantity' ? { quantity: query.sortOrder } : { name: 'asc' },
        skip: query.skip,
        take: query.take,
        include: { supplier: { select: { id: true, name: true } } },
      }),
      this.prisma.stockItem.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toItemDto(row, row.supplier)),
      total,
      query.page,
      query.limit,
    );
  }

  /**
   * Identifiants des articles au-dessus ou au-dessous de leur seuil.
   * La comparaison colonne à colonne se fait en SQL ; l'opérateur n'est
   * jamais construit depuis une entrée client.
   */
  private async idsByLevel(level: 'low' | 'ok'): Promise<string[]> {
    const rows =
      level === 'low'
        ? await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM stock_items
            WHERE "deletedAt" IS NULL AND quantity <= "minQuantity"
              AND ${restaurantFilter()}
          `
        : await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM stock_items
            WHERE "deletedAt" IS NULL AND quantity > "minQuantity"
              AND ${restaurantFilter()}
          `;

    return rows.map((row) => row.id);
  }

  /** Articles à racheter : sous le seuil, ou épuisés. */
  async alerts() {
    const items = await this.prisma.stockItem.findMany({
      where: { deletedAt: null, isActive: true },
      include: { supplier: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });

    return items
      .filter((item) => item.quantity <= item.minQuantity)
      .map((item) => this.toItemDto(item, item.supplier));
  }

  /** Synthèse du stock : combien d'articles, combien ça vaut. */
  async summary() {
    const items = await this.prisma.stockItem.findMany({
      where: { deletedAt: null, isActive: true },
      select: { quantity: true, minQuantity: true, averageCost: true },
    });

    const stockValue = items.reduce(
      (total, item) => total + Math.round(item.quantity * item.averageCost),
      0,
    );

    return {
      itemsCount: items.length,
      lowStockCount: items.filter((item) => item.quantity <= item.minQuantity && item.quantity > 0)
        .length,
      outOfStockCount: items.filter((item) => item.quantity <= 0).length,
      stockValue,
    };
  }

  async findItem(id: string) {
    const item = await this.prisma.stockItem.findFirst({
      where: { id, deletedAt: null },
      include: { supplier: { select: { id: true, name: true } } },
    });
    if (!item) throw AppException.notFound('Article de stock introuvable.');

    const movements = await this.prisma.stockMovement.findMany({
      where: { stockItemId: id },
      orderBy: { occurredAt: 'desc' },
      take: 30,
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    });

    return {
      ...this.toItemDto(item, item.supplier),
      movements: movements.map((movement) => this.toMovementDto(movement, item)),
    };
  }

  async createItem(dto: CreateStockItemDto, actor: AuthenticatedUser, context: RequestContext) {
    const name = dto.name.trim();
    const quantity = roundQuantity(dto.quantity ?? 0);
    const averageCost = Math.round(dto.averageCost ?? 0);

    if (dto.reference) {
      const existing = await this.prisma.stockItem.findFirst({
        where: { reference: dto.reference.trim().toUpperCase() },
      });
      if (existing) {
        throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce code article est déjà utilisé.');
      }
    }

    const item = await this.prisma.transaction(async (tx) => {
      const created = await tx.stockItem.create({
        data: {
          restaurantId: this.scope.resolve(dto.restaurantId),
          name,
          reference: dto.reference?.trim().toUpperCase() ?? null,
          category: (parseEnum(StockCategory, dto.category) ?? StockCategory.AUTRE) as StockCategory,
          unit: (parseEnum(StockUnit, dto.unit) ?? StockUnit.KG) as StockUnit,
          quantity,
          minQuantity: roundQuantity(dto.minQuantity ?? 0),
          averageCost,
          supplierId: dto.supplierId ?? null,
          note: dto.note ?? null,
          isActive: dto.isActive ?? true,
        },
      });

      // Le stock de départ est un mouvement comme un autre : sans lui, le
      // journal ne justifierait pas la quantité affichée.
      if (quantity > 0) {
        await tx.stockMovement.create({
          data: {
            restaurantId: created.restaurantId,
            stockItemId: created.id,
            type: StockMovementType.IN,
            reason: StockMovementReason.INVENTORY,
            quantity,
            quantityAfter: quantity,
            unitCost: averageCost,
            totalCost: Math.round(quantity * averageCost),
            note: 'Stock initial',
            createdById: actor.id,
          },
        });
      }

      return created;
    });

    await this.audit.record({
      actor,
      action: 'STOCK_ITEM_CREATE',
      module: 'stock',
      entityType: 'StockItem',
      entityId: item.id,
      newValue: { name: item.name, quantity, averageCost },
      context,
    });

    return this.toItemDto(item);
  }

  async updateItem(
    id: string,
    dto: UpdateStockItemDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.stockItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Article de stock introuvable.');

    const item = await this.prisma.stockItem.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        reference: dto.reference?.trim().toUpperCase(),
        category: parseEnum(StockCategory, dto.category),
        unit: parseEnum(StockUnit, dto.unit),
        minQuantity: dto.minQuantity === undefined ? undefined : roundQuantity(dto.minQuantity),
        averageCost: dto.averageCost === undefined ? undefined : Math.round(dto.averageCost),
        supplierId: dto.supplierId,
        note: dto.note,
        isActive: dto.isActive,
      },
    });

    await this.audit.record({
      actor,
      action: 'STOCK_ITEM_UPDATE',
      module: 'stock',
      entityType: 'StockItem',
      entityId: id,
      oldValue: { name: existing.name, minQuantity: existing.minQuantity },
      newValue: { name: item.name, minQuantity: item.minQuantity },
      context,
    });

    return this.toItemDto(item);
  }

  async removeItem(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.stockItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Article de stock introuvable.');

    await this.prisma.stockItem.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actor,
      action: 'STOCK_ITEM_DELETE',
      module: 'stock',
      entityType: 'StockItem',
      entityId: id,
      oldValue: { name: existing.name, quantity: existing.quantity },
      context,
    });

    return { success: true };
  }

  // ────────────────────────────── Mouvements ──────────────────────────────

  async listMovements(query: StockMovementQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.StockMovementWhereInput = {};

    if (query.stockItemId && query.stockItemId !== 'all') where.stockItemId = query.stockItemId;

    const type = parseEnum(StockMovementType, query.type);
    if (type) where.type = type;

    const reason = parseEnum(StockMovementReason, query.reason);
    if (reason) where.reason = reason;

    if (query.from || query.to) {
      where.occurredAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.stockItem = { name: { contains: query.search, mode: 'insensitive' } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          stockItem: { select: { id: true, name: true, unit: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          purchase: { select: { id: true, reference: true } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toMovementDto(row, row.stockItem)),
      total,
      query.page,
      query.limit,
    );
  }

  /**
   * Enregistre un mouvement saisi à la main.
   * C'est le geste quotidien de la cuisine : « j'ai sorti 8 kg de poulet ».
   */
  async createMovement(
    dto: CreateStockMovementDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const type = (parseEnum(StockMovementType, dto.type) ??
      StockMovementType.OUT) as StockMovementType;
    const reason = (parseEnum(StockMovementReason, dto.reason) ??
      StockMovementReason.OTHER) as StockMovementReason;

    const movement = await this.prisma.transaction((tx) =>
      this.applyMovement(tx, {
        stockItemId: dto.stockItemId,
        type,
        reason,
        quantity: dto.quantity,
        unitCost: dto.unitCost,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
        note: dto.note ?? null,
        createdById: actor.id,
      }),
    );

    await this.audit.record({
      actor,
      action: `STOCK_MOVEMENT_${type}`,
      module: 'stock',
      entityType: 'StockMovement',
      entityId: movement.id,
      newValue: {
        stockItemId: dto.stockItemId,
        quantity: movement.quantity,
        quantityAfter: movement.quantityAfter,
        reason: reason,
      },
      context,
    });

    const item = await this.prisma.stockItem.findUnique({ where: { id: dto.stockItemId } });
    return this.toMovementDto(movement, item ?? undefined);
  }

  /**
   * Applique un mouvement et met le stock à jour, dans la transaction de
   * l'appelant. Le coût moyen pondéré n'est recalculé qu'à l'entrée : une
   * sortie consomme au coût déjà connu, elle ne le change pas.
   */
  async applyMovement(tx: Prisma.TransactionClient, input: MovementInput) {
    const item = await tx.stockItem.findFirst({
      where: { id: input.stockItemId, deletedAt: null },
    });
    if (!item) throw AppException.notFound('Article de stock introuvable.');

    const quantity = roundQuantity(input.quantity);
    if (quantity < 0) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'La quantité d’un mouvement ne peut pas être négative.',
      );
    }

    let quantityAfter: number;
    let movementQuantity = quantity;
    let unitCost = Math.round(input.unitCost ?? item.averageCost);
    let averageCost = item.averageCost;

    if (input.type === StockMovementType.IN) {
      quantityAfter = roundQuantity(item.quantity + quantity);
      // Coût moyen pondéré : (valeur du stock + valeur de l'entrée) / total.
      const currentValue = item.quantity * item.averageCost;
      const incomingValue = quantity * unitCost;
      averageCost =
        quantityAfter > 0
          ? Math.round((currentValue + incomingValue) / quantityAfter)
          : item.averageCost;
    } else if (input.type === StockMovementType.OUT) {
      if (quantity > item.quantity && !input.allowNegative) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `Stock insuffisant : il reste ${item.quantity} ${toWire(item.unit)} de « ${item.name} ». Faites d’abord un inventaire si le compte est faux.`,
          { available: item.quantity, requested: quantity },
        );
      }
      quantityAfter = roundQuantity(item.quantity - quantity);
      unitCost = item.averageCost;
    } else {
      // Ajustement d'inventaire : la quantité reçue est le stock compté.
      quantityAfter = quantity;
      movementQuantity = roundQuantity(Math.abs(quantity - item.quantity));
      unitCost = item.averageCost;
    }

    await tx.stockItem.update({
      where: { id: item.id },
      data: {
        quantity: quantityAfter,
        averageCost,
        ...(input.type === StockMovementType.IN
          ? { lastPurchaseCost: unitCost, lastPurchaseAt: input.occurredAt ?? new Date() }
          : {}),
      },
    });

    return tx.stockMovement.create({
      data: {
        restaurantId: item.restaurantId,
        stockItemId: item.id,
        type: input.type,
        reason: input.reason,
        quantity: movementQuantity,
        quantityAfter,
        unitCost,
        totalCost: Math.round(movementQuantity * unitCost),
        note: input.note ?? null,
        purchaseId: input.purchaseId ?? null,
        createdById: input.createdById ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  }

  // ──────────────────────────── Sérialisation ─────────────────────────────

  private toItemDto(
    item: StockItem,
    supplier?: { id: string; name: string } | null,
  ) {
    return {
      id: item.id,
      name: item.name,
      reference: item.reference,
      category: toWire(item.category),
      unit: toWire(item.unit),
      quantity: item.quantity,
      minQuantity: item.minQuantity,
      averageCost: item.averageCost,
      stockValue: Math.round(item.quantity * item.averageCost),
      lastPurchaseCost: item.lastPurchaseCost,
      lastPurchaseAt: item.lastPurchaseAt?.toISOString() ?? null,
      supplierId: item.supplierId,
      supplierName: supplier?.name ?? null,
      isLow: item.quantity <= item.minQuantity,
      isOutOfStock: item.quantity <= 0,
      isActive: item.isActive,
      note: item.note,
      createdAt: item.createdAt.toISOString(),
    };
  }

  private toMovementDto(
    movement: {
      id: string;
      stockItemId: string;
      type: StockMovementType;
      reason: StockMovementReason;
      quantity: number;
      quantityAfter: number;
      unitCost: number;
      totalCost: number;
      note: string | null;
      purchaseId: string | null;
      occurredAt: Date;
      createdBy?: { firstName: string; lastName: string } | null;
      purchase?: { id: string; reference: string } | null;
    },
    item?: { id: string; name: string; unit: StockUnit } | null,
  ) {
    return {
      id: movement.id,
      stockItemId: movement.stockItemId,
      stockItemName: item?.name ?? '',
      unit: item ? toWire(item.unit) : null,
      type: toWire(movement.type),
      reason: toWire(movement.reason),
      quantity: movement.quantity,
      quantityAfter: movement.quantityAfter,
      unitCost: movement.unitCost,
      totalCost: movement.totalCost,
      note: movement.note,
      purchaseId: movement.purchaseId,
      purchaseReference: movement.purchase?.reference ?? null,
      authorName: movement.createdBy
        ? `${movement.createdBy.firstName} ${movement.createdBy.lastName}`.trim()
        : null,
      occurredAt: movement.occurredAt.toISOString(),
    };
  }
}
