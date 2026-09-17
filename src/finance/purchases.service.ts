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

/** Le devenir d'une ligne d'achat dans le stock. */
interface LotOutcome {
  purchaseItemId: string;
  stockItemId: string | null;
  name: string;
  unit: string;
  bought: number;
  lineTotal: number;
  unitPrice: number;
  consumed: number;
  remaining: number;
  exhaustedAt: string | null;
  ordersCount: number;
  sales: number;
  materialCost: number;
  orderIds: string[];
  /** Faux pour une ligne hors stock (un achat ponctuel sans article). */
  tracked: boolean;
}

const roundQty = (value: number): number => Math.round(value * 1000) / 1000;

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

      /*
       * Le prix de gros d'abord : c'est ce qu'on paie — « 450 000 le sac
       * de 50 kg », pas « 9 000 le kilo ». Le prix unitaire s'en déduit,
       * pour le coût moyen du stock. Un prix unitaire seul reste accepté.
       */
      if (line.lineTotal === undefined && line.unitPrice === undefined) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          `Indiquez le prix payé pour « ${name} ».`,
        );
      }
      const lineTotal =
        line.lineTotal !== undefined
          ? Math.round(line.lineTotal)
          : Math.round(quantity * (line.unitPrice ?? 0));
      const unitPrice =
        line.unitPrice !== undefined && line.lineTotal === undefined
          ? Math.round(line.unitPrice)
          : Math.round(lineTotal / quantity);

      /*
       * L'unité se fixe au premier achat : un article déclaré chez son
       * fournisseur n'en a pas encore de vraie. Une fois du stock en
       * réserve, elle ne bouge plus — 10 sacs ne s'additionnent pas à
       * 3 kilos.
       */
      const unitDemandee = parseEnum(StockUnit, line.unit) as StockUnit | undefined;
      const unit = (
        stockItem
          ? stockItem.quantity === 0 && unitDemandee
            ? unitDemandee
            : stockItem.unit
          : (unitDemandee ?? StockUnit.KG)
      ) as StockUnit;

      return {
        stockItemId: stockItem?.id ?? null,
        name,
        unit,
        quantity,
        unitPrice,
        lineTotal,
        minQuantity: line.minQuantity,
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
          items: {
            create: lines.map(({ minQuantity: _seuil, ...line }) => line),
          },
        },
        include: PURCHASE_INCLUDE,
      });

      // Entrée en stock, ligne par ligne : le coût moyen pondéré de chaque
      // article se met à jour au passage — et son unité ou son seuil
      // d'alerte, s'ils ont été décidés avec l'achat.
      for (const line of lines) {
        if (!line.stockItemId) continue;

        const reglages: Prisma.StockItemUpdateInput = {
          ...(line.minQuantity !== undefined
            ? { minQuantity: Math.round(line.minQuantity * 1000) / 1000 }
            : {}),
          ...(stockItemById.get(line.stockItemId)?.unit !== line.unit ? { unit: line.unit } : {}),
        };
        if (Object.keys(reglages).length > 0) {
          await tx.stockItem.update({ where: { id: line.stockItemId }, data: reglages });
        }

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

  /**
   * Ce qu'un achat a rapporté.
   *
   * La marchandise entrée par cet achat sort ensuite du stock, commande
   * après commande, jusqu'à épuisement. Pour chaque ligne, on suit ce lot
   * dans l'ordre d'arrivée — le premier entré est le premier sorti — et on
   * retrouve les commandes qui l'ont consommé. Leurs ventes et leur coût
   * matière donnent au propriétaire ce qu'il demandait : « combien on a
   * gagné après épuisement du stock acheté ».
   *
   * Une commande qui a consommé plusieurs articles de cet achat n'est
   * comptée qu'une fois dans le total.
   */
  async outcome(id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, deletedAt: null },
      include: PURCHASE_INCLUDE,
    });
    if (!purchase) throw AppException.notFound('Approvisionnement introuvable.');

    const lines: LotOutcome[] = [];
    const commandesDeLachat = new Set<string>();

    for (const item of purchase.items) {
      if (!item.stockItemId) {
        lines.push(this.lotSansSuivi(item));
        continue;
      }
      const lot = await this.followLot(item.stockItemId, purchase.id, item);
      lines.push(lot);
      for (const orderId of lot.orderIds) commandesDeLachat.add(orderId);
    }

    const ventes = await this.salesOf([...commandesDeLachat]);

    return {
      purchaseId: purchase.id,
      reference: purchase.reference,
      purchasedAt: purchase.purchasedAt.toISOString(),
      supplierName: purchase.supplier?.name ?? null,
      totalAmount: purchase.totalAmount,
      status: toWire(purchase.status),
      lines: lines.map(({ orderIds: _ids, ...line }) => line),
      /** Toutes lignes confondues, chaque commande comptée une fois. */
      ordersCount: commandesDeLachat.size,
      sales: ventes.sales,
      materialCost: ventes.materialCost,
      grossMargin: ventes.sales - ventes.materialCost,
      exhausted: lines.every((line) => line.remaining <= 0),
    };
  }

  private lotSansSuivi(item: PurchaseRow['items'][number]): LotOutcome {
    return {
      purchaseItemId: item.id,
      stockItemId: null,
      name: item.name,
      unit: toWire(item.unit),
      bought: item.quantity,
      lineTotal: item.lineTotal,
      unitPrice: item.unitPrice,
      consumed: 0,
      remaining: 0,
      exhaustedAt: null,
      ordersCount: 0,
      sales: 0,
      materialCost: 0,
      orderIds: [],
      tracked: false,
    };
  }

  /**
   * Suit un lot dans le stock de son article.
   *
   * Toutes les entrées de l'article, dans l'ordre, forment des lots ; les
   * sorties se servent d'abord dans le plus ancien. La part qui revient à
   * ce lot dit ce qu'il en reste et quelles commandes l'ont consommé.
   */
  private async followLot(
    stockItemId: string,
    purchaseId: string,
    item: PurchaseRow['items'][number],
  ): Promise<LotOutcome> {
    const movements = await this.prisma.stockMovement.findMany({
      where: { stockItemId },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        type: true,
        quantity: true,
        quantityAfter: true,
        purchaseId: true,
        orderId: true,
        totalCost: true,
        occurredAt: true,
      },
    });

    // Les lots, dans l'ordre d'arrivée. Ce qui était en réserve avant le
    // premier mouvement suivi forme un lot « d'avant », servi en premier.
    const lots: { purchaseId: string | null; remaining: number }[] = [];
    let stock = 0;
    let suivi: LotOutcome | null = null;
    const commandes = new Set<string>();
    let exhaustedAt: Date | null = null;

    for (const movement of movements) {
      const before = stock;
      stock = movement.quantityAfter;

      if (movement.type === 'IN') {
        lots.push({ purchaseId: movement.purchaseId, remaining: movement.quantity });
        if (movement.purchaseId === purchaseId) {
          suivi = {
            purchaseItemId: item.id,
            stockItemId,
            name: item.name,
            unit: toWire(item.unit),
            bought: movement.quantity,
            lineTotal: item.lineTotal,
            unitPrice: item.unitPrice,
            consumed: 0,
            remaining: movement.quantity,
            exhaustedAt: null,
            ordersCount: 0,
            sales: 0,
            materialCost: 0,
            orderIds: [],
            tracked: true,
          };
        }
        continue;
      }

      // Sortie, ou inventaire à la baisse : on sert les lots les plus anciens.
      let sortie = movement.type === 'OUT' ? movement.quantity : Math.max(0, before - stock);
      if (movement.type === 'ADJUSTMENT' && stock > before) {
        // Inventaire à la hausse : de la matière sans achat, lot à part.
        lots.push({ purchaseId: null, remaining: stock - before });
        continue;
      }

      for (const lot of lots) {
        if (sortie <= 0) break;
        if (lot.remaining <= 0) continue;
        const pris = Math.min(lot.remaining, sortie);
        lot.remaining = roundQty(lot.remaining - pris);
        sortie = roundQty(sortie - pris);

        if (suivi && lot.purchaseId === purchaseId) {
          suivi.consumed = roundQty(suivi.consumed + pris);
          suivi.remaining = lot.remaining;
          if (movement.orderId) commandes.add(movement.orderId);
          if (lot.remaining <= 0 && !exhaustedAt) exhaustedAt = movement.occurredAt;
        }
      }
    }

    if (!suivi) return this.lotSansSuivi(item);

    const ventes = await this.salesOf([...commandes]);
    return {
      ...suivi,
      exhaustedAt: exhaustedAt?.toISOString() ?? null,
      ordersCount: commandes.size,
      sales: ventes.sales,
      materialCost: ventes.materialCost,
      orderIds: [...commandes],
    };
  }

  /**
   * Les ventes des commandes qui ont consommé un lot, et leur coût matière.
   *
   * Les ventes : le sous-total de ces commandes, livrées ou en cours — une
   * commande annulée n'a rien rapporté. Le coût matière : toutes les
   * sorties de préparation de ces mêmes commandes, tous articles
   * confondus, au coût moyen du moment.
   */
  private async salesOf(orderIds: string[]): Promise<{ sales: number; materialCost: number }> {
    if (orderIds.length === 0) return { sales: 0, materialCost: 0 };

    const [ventes, matiere] = await Promise.all([
      this.prisma.order.aggregate({
        where: { id: { in: orderIds }, status: { not: 'CANCELLED' }, deletedAt: null },
        _sum: { subtotal: true },
      }),
      this.prisma.stockMovement.aggregate({
        where: { orderId: { in: orderIds }, type: StockMovementType.OUT },
        _sum: { totalCost: true },
      }),
    ]);

    return { sales: ventes._sum.subtotal ?? 0, materialCost: matiere._sum.totalCost ?? 0 };
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
