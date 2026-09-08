import { Injectable } from '@nestjs/common';
import {
  Expense,
  ExpenseCategory,
  ExpenseStatus,
  FinancePaymentMethod,
  Income,
  IncomeCategory,
  Prisma,
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
  CreateExpenseDto,
  CreateIncomeDto,
  ExpenseQueryDto,
  IncomeQueryDto,
  SettleExpenseDto,
  UpdateExpenseDto,
  UpdateIncomeDto,
} from './dto/expense.dto';

type ExpenseWithRelations = Expense & {
  supplier?: { id: string; name: string } | null;
  employee?: { id: string; firstName: string; lastName: string } | null;
  purchase?: { id: string; reference: string } | null;
  createdBy?: { firstName: string; lastName: string } | null;
};

type IncomeWithAuthor = Income & {
  createdBy?: { firstName: string; lastName: string } | null;
};

/**
 * Dépenses et recettes diverses.
 *
 * Toute sortie d'argent du restaurant passe par `Expense` — y compris les
 * achats de marchandises, qui y déposent automatiquement leur ligne. Le
 * rapport de période n'additionne que cette table : c'est ce qui garantit
 * qu'aucun franc n'est compté deux fois.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: RestaurantScopeService,
  ) {}

  // ─────────────────────────────── Dépenses ───────────────────────────────

  async list(query: ExpenseQueryDto): Promise<PaginatedResult<unknown>> {
    const where = this.buildWhere(query);

    const [rows, total, sums] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        orderBy: { incurredAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          supplier: { select: { id: true, name: true } },
          employee: { select: { id: true, firstName: true, lastName: true } },
          purchase: { select: { id: true, reference: true } },
          createdBy: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.expense.count({ where }),
      this.prisma.expense.groupBy({
        by: ['status'],
        where,
        _sum: { amount: true },
      }),
    ]);

    const result = paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);

    // Les totaux accompagnent la page : le gestionnaire veut le montant de
    // ce qu'il filtre, pas seulement des vingt lignes affichées.
    return {
      ...result,
      meta: {
        ...result.meta,
        ...this.sumsToTotals(sums),
      },
    } as PaginatedResult<unknown>;
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, deletedAt: null },
      include: {
        supplier: { select: { id: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
        purchase: { select: { id: true, reference: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });
    if (!expense) throw AppException.notFound('Dépense introuvable.');
    return this.toDto(expense);
  }

  async create(dto: CreateExpenseDto, actor: AuthenticatedUser, context: RequestContext) {
    const category = parseEnum(ExpenseCategory, dto.category);
    if (!category) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_ERROR, 'Catégorie de dépense inconnue.');
    }

    if (category === ExpenseCategory.SALAIRE && !dto.employeeId) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Un salaire doit être rattaché à un employé.',
      );
    }

    const incurredAt = dto.incurredAt ? new Date(dto.incurredAt) : new Date();
    const status = dto.status === 'pending' ? ExpenseStatus.PENDING : ExpenseStatus.PAID;

    const expense = await this.prisma.expense.create({
      data: {
        restaurantId: this.scope.resolve(dto.restaurantId),
        reference: generateDocumentReference('DEP', incurredAt),
        label: dto.label.trim(),
        category,
        amount: dto.amount,
        status,
        paymentMethod: (parseEnum(FinancePaymentMethod, dto.paymentMethod) ??
          FinancePaymentMethod.CASH) as FinancePaymentMethod,
        incurredAt,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        paidAt: status === ExpenseStatus.PAID ? incurredAt : null,
        period: dto.period ?? null,
        supplierId: dto.supplierId ?? null,
        employeeId: dto.employeeId ?? null,
        invoiceNumber: dto.invoiceNumber ?? null,
        note: dto.note ?? null,
        isRecurring: dto.isRecurring ?? false,
        createdById: actor.id,
      },
      include: {
        supplier: { select: { id: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
        purchase: { select: { id: true, reference: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    await this.audit.record({
      actor,
      action: 'EXPENSE_CREATE',
      module: 'finance',
      entityType: 'Expense',
      entityId: expense.id,
      newValue: {
        reference: expense.reference,
        category: expense.category,
        amount: expense.amount,
        status: expense.status,
      },
      context,
    });

    return this.toDto(expense);
  }

  async update(
    id: string,
    dto: UpdateExpenseDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.expense.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Dépense introuvable.');

    // Une dépense née d'un achat se corrige sur l'achat lui-même : sinon
    // le montant de la facture et celui du stock divergeraient.
    if (existing.purchaseId) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Cette dépense provient d’un approvisionnement : corrigez l’achat correspondant.',
      );
    }

    const status =
      dto.status === undefined
        ? existing.status
        : dto.status === 'pending'
          ? ExpenseStatus.PENDING
          : ExpenseStatus.PAID;

    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        label: dto.label?.trim(),
        category: parseEnum(ExpenseCategory, dto.category),
        amount: dto.amount,
        status,
        paymentMethod: parseEnum(FinancePaymentMethod, dto.paymentMethod),
        incurredAt: dto.incurredAt ? new Date(dto.incurredAt) : undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        paidAt:
          status === ExpenseStatus.PAID
            ? (existing.paidAt ?? new Date())
            : status === ExpenseStatus.PENDING
              ? null
              : undefined,
        period: dto.period,
        supplierId: dto.supplierId,
        employeeId: dto.employeeId,
        invoiceNumber: dto.invoiceNumber,
        note: dto.note,
        isRecurring: dto.isRecurring,
      },
      include: {
        supplier: { select: { id: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
        purchase: { select: { id: true, reference: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    await this.audit.record({
      actor,
      action: 'EXPENSE_UPDATE',
      module: 'finance',
      entityType: 'Expense',
      entityId: id,
      oldValue: { amount: existing.amount, status: existing.status, label: existing.label },
      newValue: { amount: expense.amount, status: expense.status, label: expense.label },
      context,
    });

    return this.toDto(expense);
  }

  /** Marque une charge en attente comme réglée. */
  async settle(
    id: string,
    dto: SettleExpenseDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.expense.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Dépense introuvable.');

    if (existing.status === ExpenseStatus.PAID) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Cette dépense est déjà réglée.');
    }
    if (existing.status === ExpenseStatus.CANCELLED) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Cette dépense a été annulée.');
    }

    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        status: ExpenseStatus.PAID,
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
        paymentMethod: parseEnum(FinancePaymentMethod, dto.paymentMethod),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
        purchase: { select: { id: true, reference: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    // L'achat suit sa dépense : régler la facture, c'est solder l'achat.
    if (expense.purchaseId) {
      await this.prisma.purchase.update({
        where: { id: expense.purchaseId },
        data: { status: ExpenseStatus.PAID },
      });
    }

    await this.audit.record({
      actor,
      action: 'EXPENSE_SETTLE',
      module: 'finance',
      entityType: 'Expense',
      entityId: id,
      newValue: { amount: expense.amount, paidAt: expense.paidAt?.toISOString() },
      context,
    });

    return this.toDto(expense);
  }

  /**
   * Suppression logique. Une dépense retirée du journal n'entre plus dans
   * le rapport, mais la ligne reste en base : un rapport déjà imprimé doit
   * pouvoir être expliqué.
   */
  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.expense.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Dépense introuvable.');

    if (existing.purchaseId) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Cette dépense provient d’un approvisionnement : annulez l’achat correspondant.',
      );
    }

    await this.prisma.expense.update({
      where: { id },
      data: { deletedAt: new Date(), status: ExpenseStatus.CANCELLED },
    });

    await this.audit.record({
      actor,
      action: 'EXPENSE_DELETE',
      module: 'finance',
      entityType: 'Expense',
      entityId: id,
      oldValue: { reference: existing.reference, amount: existing.amount },
      context,
    });

    return { success: true };
  }

  /** Charges dont l'échéance est passée ou proche : le rappel du mois. */
  async dueSoon(days = 7) {
    const limit = new Date(Date.now() + days * 86_400_000);

    const rows = await this.prisma.expense.findMany({
      where: {
        deletedAt: null,
        status: ExpenseStatus.PENDING,
        OR: [{ dueDate: { lte: limit } }, { dueDate: null }],
      },
      orderBy: [{ dueDate: 'asc' }, { incurredAt: 'asc' }],
      take: 50,
      include: {
        supplier: { select: { id: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
        purchase: { select: { id: true, reference: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    return rows.map((row) => this.toDto(row));
  }

  // ─────────────────────────────── Recettes ───────────────────────────────

  async listIncomes(query: IncomeQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.IncomeWhereInput = { deletedAt: null };

    const category = parseEnum(IncomeCategory, query.category);
    if (category) where.category = category;

    if (query.from || query.to) {
      where.receivedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { label: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total, sum] = await Promise.all([
      this.prisma.income.findMany({
        where,
        orderBy: { receivedAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
        include: { createdBy: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.income.count({ where }),
      this.prisma.income.aggregate({ where, _sum: { amount: true } }),
    ]);

    const result = paginate(
      rows.map((row) => this.toIncomeDto(row)),
      total,
      query.page,
      query.limit,
    );

    return {
      ...result,
      meta: { ...result.meta, totalAmount: sum._sum.amount ?? 0 },
    } as PaginatedResult<unknown>;
  }

  async createIncome(dto: CreateIncomeDto, actor: AuthenticatedUser, context: RequestContext) {
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();

    const income = await this.prisma.income.create({
      data: {
        restaurantId: this.scope.resolve(dto.restaurantId),
        reference: generateDocumentReference('REC', receivedAt),
        label: dto.label.trim(),
        category: (parseEnum(IncomeCategory, dto.category) ??
          IncomeCategory.AUTRE) as IncomeCategory,
        amount: dto.amount,
        method: (parseEnum(FinancePaymentMethod, dto.method) ??
          FinancePaymentMethod.CASH) as FinancePaymentMethod,
        receivedAt,
        note: dto.note ?? null,
        createdById: actor.id,
      },
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    });

    await this.audit.record({
      actor,
      action: 'INCOME_CREATE',
      module: 'finance',
      entityType: 'Income',
      entityId: income.id,
      newValue: { reference: income.reference, amount: income.amount, label: income.label },
      context,
    });

    return this.toIncomeDto(income);
  }

  async updateIncome(
    id: string,
    dto: UpdateIncomeDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.income.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Recette introuvable.');

    const income = await this.prisma.income.update({
      where: { id },
      data: {
        label: dto.label?.trim(),
        category: parseEnum(IncomeCategory, dto.category),
        amount: dto.amount,
        method: parseEnum(FinancePaymentMethod, dto.method),
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined,
        note: dto.note,
      },
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    });

    await this.audit.record({
      actor,
      action: 'INCOME_UPDATE',
      module: 'finance',
      entityType: 'Income',
      entityId: id,
      oldValue: { amount: existing.amount, label: existing.label },
      newValue: { amount: income.amount, label: income.label },
      context,
    });

    return this.toIncomeDto(income);
  }

  async removeIncome(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.income.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Recette introuvable.');

    await this.prisma.income.update({ where: { id }, data: { deletedAt: new Date() } });

    await this.audit.record({
      actor,
      action: 'INCOME_DELETE',
      module: 'finance',
      entityType: 'Income',
      entityId: id,
      oldValue: { reference: existing.reference, amount: existing.amount },
      context,
    });

    return { success: true };
  }

  // ────────────────────────────── Utilitaires ─────────────────────────────

  buildWhere(query: ExpenseQueryDto): Prisma.ExpenseWhereInput {
    const where: Prisma.ExpenseWhereInput = { deletedAt: null };

    const category = parseEnum(ExpenseCategory, query.category);
    if (category) where.category = category;

    const status = parseEnum(ExpenseStatus, query.status);
    if (status) where.status = status;

    if (query.supplierId && query.supplierId !== 'all') where.supplierId = query.supplierId;
    if (query.employeeId && query.employeeId !== 'all') where.employeeId = query.employeeId;
    if (query.period) where.period = query.period;

    if (query.from || query.to) {
      where.incurredAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { label: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search, mode: 'insensitive' } },
        { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private sumsToTotals(sums: { status: ExpenseStatus; _sum: { amount: number | null } }[]) {
    const byStatus = new Map(sums.map((row) => [row.status, row._sum.amount ?? 0]));
    const paid = byStatus.get(ExpenseStatus.PAID) ?? 0;
    const pending = byStatus.get(ExpenseStatus.PENDING) ?? 0;
    return { totalAmount: paid + pending, paidAmount: paid, pendingAmount: pending };
  }

  toDto(expense: ExpenseWithRelations) {
    return {
      id: expense.id,
      reference: expense.reference,
      label: expense.label,
      category: toWire(expense.category),
      amount: expense.amount,
      status: toWire(expense.status),
      paymentMethod: toWire(expense.paymentMethod),
      incurredAt: expense.incurredAt.toISOString(),
      dueDate: expense.dueDate?.toISOString() ?? null,
      paidAt: expense.paidAt?.toISOString() ?? null,
      period: expense.period,
      supplierId: expense.supplierId,
      supplierName: expense.supplier?.name ?? null,
      employeeId: expense.employeeId,
      employeeName: expense.employee
        ? `${expense.employee.firstName} ${expense.employee.lastName}`.trim()
        : null,
      purchaseId: expense.purchaseId,
      purchaseReference: expense.purchase?.reference ?? null,
      invoiceNumber: expense.invoiceNumber,
      note: expense.note,
      isRecurring: expense.isRecurring,
      authorName: expense.createdBy
        ? `${expense.createdBy.firstName} ${expense.createdBy.lastName}`.trim()
        : null,
      createdAt: expense.createdAt.toISOString(),
    };
  }

  toIncomeDto(income: IncomeWithAuthor) {
    return {
      id: income.id,
      reference: income.reference,
      label: income.label,
      category: toWire(income.category),
      amount: income.amount,
      method: toWire(income.method),
      receivedAt: income.receivedAt.toISOString(),
      note: income.note,
      authorName: income.createdBy
        ? `${income.createdBy.firstName} ${income.createdBy.lastName}`.trim()
        : null,
      createdAt: income.createdAt.toISOString(),
    };
  }
}
