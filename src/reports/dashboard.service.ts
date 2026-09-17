import { Injectable } from '@nestjs/common';
import { AccountStatus, OrderStatus, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ORDER_SUMMARY_INCLUDE, toOrderSummary } from '../orders/order.mapper';
import { UNPAID_ONLINE } from '../orders/unpaid-orders';
import { ReportsService } from './reports.service';

/**
 * Tableaux de bord.
 *
 * Une seule requête HTTP renvoie tout ce dont l'écran a besoin
 * (§44 du contrat) : indicateurs, séries, dernières commandes, meilleures
 * ventes, état de la flotte. Le front n'a pas à enchaîner vingt appels
 * pour dessiner une page.
 *
 * Les blocs sont calculés en parallèle, chacun par une agrégation en base.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  /** Tableau de bord opérationnel — ADMIN et SUPER_ADMIN. */
  async admin(input: { period?: string; from?: string; to?: string }) {
    const range = this.reports.resolveRange(input);
    const previous = this.reports.previousRange(range);

    const [
      totals,
      previousTotals,
      series,
      recentOrders,
      topProducts,
      drivers,
      statusBreakdown,
      liveCounts,
      customers,
      previousCustomers,
    ] = await Promise.all([
      this.reports.totals(range.from, range.to),
      this.reports.totals(previous.from, previous.to),
      this.reports.series(range),
      this.prisma.order.findMany({
        // Une commande en ligne jamais payée n'est pas une commande pour
        // le restaurant : elle n'a rien à faire dans « dernières commandes ».
        where: { deletedAt: null, NOT: UNPAID_ONLINE },
        include: ORDER_SUMMARY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.reports.topProducts(range.from, range.to, 8),
      this.reports.driverOverview(),
      this.reports.statusBreakdown(range.from, range.to),
      this.liveCounts(),
      this.activeCustomers(range.from, range.to),
      this.activeCustomers(previous.from, previous.to),
    ]);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), period: range.period },
      stats: {
        revenue: {
          value: totals.revenue,
          changePercent: this.reports.changePercent(totals.revenue, previousTotals.revenue),
        },
        orders: {
          value: totals.orders,
          changePercent: this.reports.changePercent(totals.orders, previousTotals.orders),
        },
        pendingOrders: { value: liveCounts.pending, changePercent: 0 },
        ongoingDeliveries: { value: drivers.ongoingDeliveries, changePercent: 0 },
        activeCustomers: {
          value: customers,
          changePercent: this.reports.changePercent(customers, previousCustomers),
        },
        averageBasket: {
          value: totals.averageBasket,
          changePercent: this.reports.changePercent(
            totals.averageBasket,
            previousTotals.averageBasket,
          ),
        },
      },
      /** Compteurs « live » de la barre d'état : ce qui se passe maintenant. */
      live: liveCounts,
      series,
      recentOrders: recentOrders.map((order) =>
        toOrderSummary({
          ...order,
          _count: { items: order.items.reduce((sum, item) => sum + item.quantity, 0) },
        }),
      ),
      topProducts,
      drivers,
      statusBreakdown,
    };
  }

  /**
   * Tableau de bord du SUPER_ADMIN.
   * Il reprend l'opérationnel et y ajoute la supervision : comptes
   * d'administration, santé technique, alertes de sécurité, audit récent.
   */
  async superAdmin(input: { period?: string; from?: string; to?: string }) {
    const base = await this.admin(input);

    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);

    const [adminsCount, activeAdmins, activeUsers24h, alerts, recentAuditLogs, health, promotions] =
      await Promise.all([
        this.prisma.user.count({
          where: { role: { in: [Role.ADMIN, Role.SUPER_ADMIN] }, deletedAt: null },
        }),
        this.prisma.user.count({
          where: {
            role: { in: [Role.ADMIN, Role.SUPER_ADMIN] },
            status: AccountStatus.ACTIVE,
            deletedAt: null,
          },
        }),
        this.prisma.user.count({ where: { lastActivityAt: { gte: dayAgo }, deletedAt: null } }),
        this.prisma.securityAlert.findMany({
          where: { resolvedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        this.audit.recent(10),
        this.health(),
        this.prisma.promotion.count({ where: { isActive: true, deletedAt: null } }),
      ]);

    return {
      ...base,
      adminsCount,
      activeAdmins,
      activeUsers24h,
      activePromotions: promotions,
      health,
      securityAlerts: alerts.map((alert) => ({
        id: alert.id,
        severity: alert.severity.toLowerCase(),
        title: alert.title,
        description: alert.description,
        at: alert.createdAt.toISOString(),
      })),
      recentAuditLogs,
    };
  }

  /** Compteurs instantanés par statut de commande. */
  private async liveCounts() {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        NOT: UNPAID_ONLINE,
        status: {
          in: [
            OrderStatus.PENDING,
            OrderStatus.CONFIRMED,
            OrderStatus.PREPARING,
            OrderStatus.READY,
            OrderStatus.ASSIGNED,
            OrderStatus.OUT_FOR_DELIVERY,
          ],
        },
      },
      _count: { _all: true },
    });

    const byStatus = new Map(rows.map((row) => [row.status, row._count._all]));

    return {
      pending: byStatus.get(OrderStatus.PENDING) ?? 0,
      confirmed: byStatus.get(OrderStatus.CONFIRMED) ?? 0,
      preparing: byStatus.get(OrderStatus.PREPARING) ?? 0,
      ready: byStatus.get(OrderStatus.READY) ?? 0,
      assigned: byStatus.get(OrderStatus.ASSIGNED) ?? 0,
      outForDelivery: byStatus.get(OrderStatus.OUT_FOR_DELIVERY) ?? 0,
    };
  }

  /** Clients ayant commandé au moins une fois sur la période. */
  private async activeCustomers(from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.order.groupBy({
      by: ['customerId'],
      where: { createdAt: { gte: from, lte: to }, deletedAt: null },
    });
    return rows.length;
  }

  /** Santé technique, telle qu'affichée au SUPER_ADMIN. */
  private async health() {
    const startedAt = Date.now();
    let database: 'up' | 'degraded' | 'down' = 'up';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    const responseMs = Date.now() - startedAt;
    const cache = (await this.redis.ping()) ? 'up' : 'degraded';

    const errorsLast24h = await this.prisma.auditLog.count({
      where: { result: 'FAILURE', createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    });

    return {
      api: 'up' as const,
      database,
      websocket: 'up' as const,
      cache,
      uptimePercent: 100,
      errorsLast24h,
      averageResponseMs: responseMs,
    };
  }
}
