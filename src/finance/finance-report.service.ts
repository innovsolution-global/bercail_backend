import { Injectable } from '@nestjs/common';
import { ExpenseStatus, OrderStatus, Prisma } from '@prisma/client';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { toWire } from '../common/utils/wire-enum.util';
import { restaurantFilter } from '../common/context/restaurant-sql';
import { PrismaService } from '../database/prisma.service';
import type { FinanceRangeQueryDto } from './dto/common.dto';

export type Granularity = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Unité `date_trunc` autorisée — jamais construite depuis une entrée client. */
const TRUNC_UNIT: Record<Granularity, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

const MONTH_LABELS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

export interface FinanceRange {
  from: Date;
  to: Date;
  granularity: Granularity;
}

interface LedgerRow {
  id: string;
  direction: 'in' | 'out';
  kind: string;
  reference: string;
  label: string;
  category: string;
  amount: number;
  method: string;
  status: string;
  occurredAt: Date;
}

/**
 * Rapport d'activité.
 *
 * Le principe tient en une ligne : ce qui rentre moins ce qui sort. Ce qui
 * rentre, ce sont les ventes abouties et les recettes diverses ; ce qui
 * sort, ce sont les dépenses — achats compris, puisqu'un achat dépose sa
 * ligne dans le même registre.
 *
 * Comme pour les rapports de vente, tout est agrégé par la base : le
 * serveur ne charge jamais la totalité des écritures pour les additionner.
 */
@Injectable()
export class FinanceReportService {
  constructor(private readonly prisma: PrismaService) {}

  resolveRange(query: FinanceRangeQueryDto): FinanceRange {
    const granularity = (
      ['daily', 'weekly', 'monthly', 'yearly'].includes(query.granularity ?? '')
        ? query.granularity
        : 'daily'
    ) as Granularity;

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);

    return { from, to, granularity };
  }

  /** Bornes d'un mois `AAAA-MM`. Par défaut : le mois en cours. */
  resolvePeriod(period?: string): { period: string; from: Date; to: Date; label: string } {
    const now = new Date();
    const matched = period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : null;

    const year = matched ? Number(matched.slice(0, 4)) : now.getUTCFullYear();
    const month = matched ? Number(matched.slice(5, 7)) : now.getUTCMonth() + 1;

    return {
      period: `${year}-${String(month).padStart(2, '0')}`,
      from: new Date(Date.UTC(year, month - 1, 1)),
      to: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
      label: `${MONTH_LABELS[month - 1]} ${year}`,
    };
  }

  // ─────────────────────────────── Synthèse ───────────────────────────────

  /**
   * Ce qui rentre, ce qui sort, ce qui reste — sur une période libre.
   */
  async summary(from: Date, to: Date) {
    const [sales, otherIncome, expenses, stock, unpaidSales] = await Promise.all([
      this.salesTotals(from, to),
      this.prisma.income.aggregate({
        where: { deletedAt: null, receivedAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.expense.groupBy({
        by: ['status'],
        where: {
          deletedAt: null,
          status: { not: ExpenseStatus.CANCELLED },
          incurredAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.stockValue(),
      this.prisma.order.aggregate({
        where: {
          deletedAt: null,
          status: OrderStatus.DELIVERED,
          paymentStatus: { not: 'PAID' },
          createdAt: { gte: from, lte: to },
        },
        _sum: { total: true },
      }),
    ]);

    const paidExpenses =
      expenses.find((row) => row.status === ExpenseStatus.PAID)?._sum.amount ?? 0;
    const pendingExpenses =
      expenses.find((row) => row.status === ExpenseStatus.PENDING)?._sum.amount ?? 0;
    const totalExpenses = paidExpenses + pendingExpenses;

    const otherIncomeTotal = otherIncome._sum.amount ?? 0;
    const totalIncome = sales.total + otherIncomeTotal;
    const netResult = totalIncome - totalExpenses;

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      income: {
        sales: sales.total,
        salesOnline: sales.online,
        salesPos: sales.pos,
        ordersCount: sales.count,
        averageBasket: sales.count > 0 ? Math.round(sales.total / sales.count) : 0,
        otherIncome: otherIncomeTotal,
        otherIncomeCount: otherIncome._count,
        total: totalIncome,
        /** Commandes livrées dont l'argent n'est pas encore encaissé. */
        outstanding: unpaidSales._sum.total ?? 0,
      },
      expenses: {
        total: totalExpenses,
        paid: paidExpenses,
        pending: pendingExpenses,
        count: expenses.reduce((total, row) => total + row._count, 0),
      },
      result: {
        net: netResult,
        margin: totalIncome > 0 ? Math.round((netResult / totalIncome) * 1000) / 10 : 0,
      },
      stock,
    };
  }

  /** Chiffre d'affaires abouti, réparti par canal de vente. */
  private async salesTotals(from: Date, to: Date) {
    const rows = await this.prisma.order.groupBy({
      by: ['channel'],
      where: {
        deletedAt: null,
        status: OrderStatus.DELIVERED,
        createdAt: { gte: from, lte: to },
      },
      _sum: { total: true },
      _count: true,
    });

    const online = rows.find((row) => row.channel === 'ONLINE');
    const pos = rows.find((row) => row.channel === 'POS');

    return {
      total: rows.reduce((total, row) => total + (row._sum.total ?? 0), 0),
      online: online?._sum.total ?? 0,
      pos: pos?._sum.total ?? 0,
      count: rows.reduce((total, row) => total + row._count, 0),
    };
  }

  /** Valeur du stock au coût moyen pondéré. */
  private async stockValue() {
    const rows = await this.prisma.$queryRaw<{ value: number; items: number }[]>`
      SELECT COALESCE(SUM(ROUND(quantity * "averageCost")), 0)::int AS value,
             COUNT(*)::int AS items
      FROM stock_items
      WHERE "deletedAt" IS NULL
        AND ${restaurantFilter()} AND "isActive" = true
    `;

    return { value: Number(rows[0]?.value ?? 0), itemsCount: Number(rows[0]?.items ?? 0) };
  }

  /** Répartition des dépenses par catégorie, du plus lourd au plus léger. */
  async expensesByCategory(from: Date, to: Date) {
    const rows = await this.prisma.expense.groupBy({
      by: ['category'],
      where: {
        deletedAt: null,
        status: { not: ExpenseStatus.CANCELLED },
        incurredAt: { gte: from, lte: to },
      },
      _sum: { amount: true },
      _count: true,
    });

    const total = rows.reduce((sum, row) => sum + (row._sum.amount ?? 0), 0);

    return rows
      .map((row) => ({
        category: toWire(row.category),
        amount: row._sum.amount ?? 0,
        count: row._count,
        share: total > 0 ? Math.round(((row._sum.amount ?? 0) / total) * 1000) / 10 : 0,
      }))
      .sort((left, right) => right.amount - left.amount);
  }

  /**
   * Série temporelle recettes / dépenses.
   * Deux `date_trunc` en base, recollés par période.
   */
  async series(range: FinanceRange) {
    const unit = Prisma.raw(`'${TRUNC_UNIT[range.granularity]}'`);

    const [sales, incomes, expenses] = await Promise.all([
      this.prisma.$queryRaw<{ bucket: Date; amount: number }[]>`
        SELECT date_trunc(${unit}, "createdAt") AS bucket,
               COALESCE(SUM(total), 0)::int AS amount
        FROM orders
        WHERE "deletedAt" IS NULL
          AND ${restaurantFilter()} AND status = 'DELIVERED'
          AND "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
        GROUP BY bucket
      `,
      this.prisma.$queryRaw<{ bucket: Date; amount: number }[]>`
        SELECT date_trunc(${unit}, "receivedAt") AS bucket,
               COALESCE(SUM(amount), 0)::int AS amount
        FROM incomes
        WHERE "deletedAt" IS NULL
          AND ${restaurantFilter()}
          AND "receivedAt" >= ${range.from} AND "receivedAt" <= ${range.to}
        GROUP BY bucket
      `,
      this.prisma.$queryRaw<{ bucket: Date; amount: number }[]>`
        SELECT date_trunc(${unit}, "incurredAt") AS bucket,
               COALESCE(SUM(amount), 0)::int AS amount
        FROM expenses
        WHERE "deletedAt" IS NULL
          AND ${restaurantFilter()} AND status <> 'CANCELLED'
          AND "incurredAt" >= ${range.from} AND "incurredAt" <= ${range.to}
        GROUP BY bucket
      `,
    ]);

    const buckets = new Map<string, { revenue: number; otherIncome: number; expenses: number }>();

    const ensure = (bucket: Date) => {
      const key = bucket.toISOString();
      if (!buckets.has(key)) buckets.set(key, { revenue: 0, otherIncome: 0, expenses: 0 });
      return buckets.get(key)!;
    };

    for (const row of sales) ensure(row.bucket).revenue += Number(row.amount);
    for (const row of incomes) ensure(row.bucket).otherIncome += Number(row.amount);
    for (const row of expenses) ensure(row.bucket).expenses += Number(row.amount);

    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, values]) => {
        const income = values.revenue + values.otherIncome;
        return {
          date,
          label: this.formatBucket(new Date(date), range.granularity),
          revenue: values.revenue,
          otherIncome: values.otherIncome,
          income,
          expenses: values.expenses,
          net: income - values.expenses,
        };
      });
  }

  // ──────────────────────────── Journal de caisse ─────────────────────────

  /**
   * Journal unifié : ventes, recettes et dépenses sur une même ligne de
   * temps. L'union est faite en SQL, ce qui permet de paginer un registre
   * qui vit dans trois tables sans tout charger en mémoire.
   */
  async ledger(options: {
    from: Date;
    to: Date;
    direction?: 'in' | 'out';
    page: number;
    limit: number;
  }): Promise<PaginatedResult<unknown>> {
    const { from, to, page, limit } = options;
    const direction = options.direction ?? null;
    const offset = (page - 1) * limit;

    const source = Prisma.sql`
      SELECT e.id::text AS id,
             'out'::text AS direction,
             (CASE
               WHEN e."purchaseId" IS NOT NULL THEN 'purchase'
               WHEN e.category = 'SALAIRE' THEN 'salary'
               ELSE 'expense'
             END)::text AS kind,
             e.reference AS reference,
             e.label AS label,
             lower(e.category::text) AS category,
             e.amount AS amount,
             lower(e."paymentMethod"::text) AS method,
             lower(e.status::text) AS status,
             e."incurredAt" AS "occurredAt"
      FROM expenses e
      WHERE e."deletedAt" IS NULL
        AND ${restaurantFilter('e."restaurantId"')}
        AND e.status <> 'CANCELLED'
        AND e."incurredAt" >= ${from} AND e."incurredAt" <= ${to}

      UNION ALL

      SELECT i.id::text,
             'in'::text,
             'income'::text,
             i.reference,
             i.label,
             lower(i.category::text),
             i.amount,
             lower(i.method::text),
             'paid'::text,
             i."receivedAt"
      FROM incomes i
      WHERE i."deletedAt" IS NULL
        AND ${restaurantFilter('i."restaurantId"')}
        AND i."receivedAt" >= ${from} AND i."receivedAt" <= ${to}

      UNION ALL

      SELECT o.id::text,
             'in'::text,
             'sale'::text,
             o.reference,
             (CASE WHEN o.channel = 'POS' THEN 'Vente au comptoir' ELSE 'Commande en ligne' END)::text,
             lower(o.channel::text),
             o.total,
             lower(o."paymentMethod"::text),
             lower(o."paymentStatus"::text),
             o."createdAt"
      FROM orders o
      WHERE o."deletedAt" IS NULL
        AND ${restaurantFilter('o."restaurantId"')}
        AND o.status = 'DELIVERED'
        AND o."createdAt" >= ${from} AND o."createdAt" <= ${to}
    `;

    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<LedgerRow[]>`
        SELECT * FROM (${source}) AS ledger
        WHERE (${direction}::text IS NULL OR ledger.direction = ${direction}::text)
        ORDER BY ledger."occurredAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<{ total: number; inflow: number; outflow: number }[]>`
        SELECT COUNT(*)::int AS total,
               COALESCE(SUM(CASE WHEN ledger.direction = 'in' THEN ledger.amount ELSE 0 END), 0)::bigint AS inflow,
               COALESCE(SUM(CASE WHEN ledger.direction = 'out' THEN ledger.amount ELSE 0 END), 0)::bigint AS outflow
        FROM (${source}) AS ledger
        WHERE (${direction}::text IS NULL OR ledger.direction = ${direction}::text)
      `,
    ]);

    const totals = counted[0] ?? { total: 0, inflow: 0, outflow: 0 };
    const inflow = Number(totals.inflow);
    const outflow = Number(totals.outflow);

    const result = paginate(
      rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        kind: row.kind,
        reference: row.reference,
        label: row.label,
        category: row.category,
        amount: Number(row.amount),
        method: row.method,
        status: row.status,
        occurredAt: new Date(row.occurredAt).toISOString(),
      })),
      Number(totals.total),
      page,
      limit,
    );

    return {
      ...result,
      meta: { ...result.meta, inflow, outflow, net: inflow - outflow },
    } as PaginatedResult<unknown>;
  }

  // ──────────────────────── Rapport mensuel d'activité ────────────────────

  /**
   * Le document que le propriétaire veut voir en fin de mois : recettes,
   * charges, résultat, comparaison avec le mois précédent, et le détail
   * de ce qui a coûté le plus cher.
   */
  async monthlyReport(period?: string) {
    const current = this.resolvePeriod(period);

    const previousMonth = new Date(
      Date.UTC(current.from.getUTCFullYear(), current.from.getUTCMonth() - 1, 1),
    );
    const previous = this.resolvePeriod(
      `${previousMonth.getUTCFullYear()}-${String(previousMonth.getUTCMonth() + 1).padStart(2, '0')}`,
    );

    const [summary, previousSummary, byCategory, series, topSuppliers, payroll, topProducts] =
      await Promise.all([
        this.summary(current.from, current.to),
        this.summary(previous.from, previous.to),
        this.expensesByCategory(current.from, current.to),
        this.series({ from: current.from, to: current.to, granularity: 'daily' }),
        this.topSuppliers(current.from, current.to),
        this.payrollTotal(current.period),
        this.topProducts(current.from, current.to),
      ]);

    const variation = (now: number, before: number): number =>
      before === 0 ? (now === 0 ? 0 : 100) : Math.round(((now - before) / before) * 1000) / 10;

    return {
      period: current.period,
      label: current.label,
      range: { from: current.from.toISOString(), to: current.to.toISOString() },
      summary,
      comparison: {
        period: previous.period,
        label: previous.label,
        incomeChange: variation(summary.income.total, previousSummary.income.total),
        expensesChange: variation(summary.expenses.total, previousSummary.expenses.total),
        resultChange: variation(summary.result.net, previousSummary.result.net),
        previous: {
          income: previousSummary.income.total,
          expenses: previousSummary.expenses.total,
          net: previousSummary.result.net,
        },
      },
      expensesByCategory: byCategory,
      series,
      topSuppliers,
      topProducts,
      payroll,
    };
  }

  /** Fournisseurs par montant acheté sur la période. */
  async topSuppliers(from: Date, to: Date, take = 8) {
    const rows = await this.prisma.purchase.groupBy({
      by: ['supplierId'],
      where: {
        deletedAt: null,
        status: { not: ExpenseStatus.CANCELLED },
        purchasedAt: { gte: from, lte: to },
      },
      _sum: { totalAmount: true },
      _count: true,
    });

    const supplierIds = rows
      .map((row) => row.supplierId)
      .filter((value): value is string => Boolean(value));

    const suppliers = supplierIds.length
      ? await this.prisma.supplier.findMany({
          where: { id: { in: supplierIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

    return rows
      .map((row) => ({
        supplierId: row.supplierId,
        name: row.supplierId ? (nameById.get(row.supplierId) ?? 'Fournisseur supprimé') : 'Sans fournisseur',
        amount: row._sum.totalAmount ?? 0,
        purchases: row._count,
      }))
      .sort((left, right) => right.amount - left.amount)
      .slice(0, take);
  }

  /** Ce que la vente a rapporté, plat par plat. */
  async topProducts(from: Date, to: Date, take = 10) {
    return this.prisma.$queryRaw<{ name: string; quantity: number; revenue: number }[]>`
      SELECT oi.name AS name,
             SUM(oi.quantity)::int AS quantity,
             SUM(oi."lineTotal")::int AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE o."deletedAt" IS NULL
        AND o.status = 'DELIVERED'
        AND o."createdAt" >= ${from} AND o."createdAt" <= ${to}
      GROUP BY oi.name
      ORDER BY revenue DESC
      LIMIT ${take}
    `;
  }

  /** Masse salariale d'un mois. */
  async payrollTotal(period: string) {
    const rows = await this.prisma.expense.groupBy({
      by: ['status'],
      where: { category: 'SALAIRE', period, deletedAt: null },
      _sum: { amount: true },
      _count: true,
    });

    return {
      period,
      total: rows.reduce((sum, row) => sum + (row._sum.amount ?? 0), 0),
      paid: rows.find((row) => row.status === ExpenseStatus.PAID)?._sum.amount ?? 0,
      pending: rows.find((row) => row.status === ExpenseStatus.PENDING)?._sum.amount ?? 0,
      headcount: rows.reduce((sum, row) => sum + row._count, 0),
    };
  }

  private formatBucket(date: Date, granularity: Granularity): string {
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = MONTH_LABELS[date.getUTCMonth()];
    const year = date.getUTCFullYear();

    switch (granularity) {
      case 'weekly':
        return `sem. du ${day} ${month.slice(0, 4)}.`;
      case 'monthly':
        return `${month} ${year}`;
      case 'yearly':
        return String(year);
      default:
        return `${day} ${month.slice(0, 4)}.`;
    }
  }
}
