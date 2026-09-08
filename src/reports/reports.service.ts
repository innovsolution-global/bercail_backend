import { Injectable } from '@nestjs/common';
import { DeliveryStatus, OrderStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import { restaurantFilter, restaurantFilterViaOrder } from '../common/context/restaurant-sql';
import { toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';

export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ReportRange {
  from: Date;
  to: Date;
  period: ReportPeriod;
}

interface SeriesRow {
  bucket: Date;
  orders: number;
  revenue: number;
}

interface DeliverySeriesRow {
  bucket: Date;
  deliveries: number;
}

/** Unité `date_trunc` autorisée — jamais construite depuis une entrée client. */
const TRUNC_UNIT: Record<ReportPeriod, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

/**
 * Rapports et séries temporelles.
 *
 * Toutes les statistiques sont calculées **par la base** : agrégats,
 * regroupements et séries passent par `groupBy`, `aggregate` ou une
 * requête SQL avec `date_trunc`. À aucun moment le serveur ne charge
 * l'ensemble des commandes en mémoire pour les additionner — c'est la
 * différence entre un tableau de bord qui tient à 100 commandes et un qui
 * tient à 100 000.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Période demandée, avec des bornes toujours définies. */
  resolveRange(input: { from?: string; to?: string; period?: string }): ReportRange {
    const period = (['daily', 'weekly', 'monthly', 'yearly'].includes(input.period ?? '')
      ? input.period
      : 'daily') as ReportPeriod;

    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from
      ? new Date(input.from)
      : new Date(to.getTime() - this.defaultWindowDays(period) * 24 * 3600 * 1000);

    return { from, to, period };
  }

  private defaultWindowDays(period: ReportPeriod): number {
    switch (period) {
      case 'weekly':
        return 84; // 12 semaines
      case 'monthly':
        return 365;
      case 'yearly':
        return 365 * 3;
      default:
        return 30;
    }
  }

  /** Période précédente de même durée — sert au calcul des variations. */
  previousRange(range: ReportRange): { from: Date; to: Date } {
    const duration = range.to.getTime() - range.from.getTime();
    return {
      from: new Date(range.from.getTime() - duration),
      to: new Date(range.from.getTime()),
    };
  }

  /**
   * Série temporelle chiffre d'affaires / commandes / livraisons.
   * Un `date_trunc` en base, deux requêtes, aucune boucle applicative.
   */
  async series(range: ReportRange) {
    const unit = Prisma.raw(`'${TRUNC_UNIT[range.period]}'`);

    const [orders, deliveries] = await Promise.all([
      this.prisma.$queryRaw<SeriesRow[]>`
        SELECT date_trunc(${unit}, "createdAt") AS bucket,
               COUNT(*)::int AS orders,
               COALESCE(SUM(CASE WHEN status = 'DELIVERED' THEN total ELSE 0 END), 0)::int AS revenue
        FROM orders
        WHERE "createdAt" >= ${range.from}
          AND "createdAt" <= ${range.to}
          AND "deletedAt" IS NULL
          AND ${restaurantFilter()}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
      this.prisma.$queryRaw<DeliverySeriesRow[]>`
        SELECT date_trunc(${unit}, "deliveredAt") AS bucket,
               COUNT(*)::int AS deliveries
        FROM deliveries
        WHERE "deliveredAt" >= ${range.from}
          AND "deliveredAt" <= ${range.to}
          AND status = 'DELIVERED'
          AND ${restaurantFilterViaOrder('"orderId"')}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    ]);

    const deliveriesByBucket = new Map(
      deliveries.map((row) => [row.bucket.toISOString(), row.deliveries]),
    );

    return orders.map((row) => ({
      label: this.formatBucket(row.bucket, range.period),
      date: row.bucket.toISOString(),
      revenue: Number(row.revenue),
      orders: Number(row.orders),
      deliveries: deliveriesByBucket.get(row.bucket.toISOString()) ?? 0,
    }));
  }

  /** Totaux d'une période. */
  async totals(from: Date, to: Date) {
    const window: Prisma.OrderWhereInput = {
      createdAt: { gte: from, lte: to },
      deletedAt: null,
    };

    const [orders, revenue, delivered, cancelled, newCustomers] = await Promise.all([
      this.prisma.order.count({ where: window }),
      this.prisma.order.aggregate({
        _sum: { total: true },
        _avg: { total: true },
        where: { ...window, status: OrderStatus.DELIVERED },
      }),
      this.prisma.order.count({ where: { ...window, status: OrderStatus.DELIVERED } }),
      this.prisma.order.count({ where: { ...window, status: OrderStatus.CANCELLED } }),
      this.prisma.user.count({
        where: { role: Role.CUSTOMER, createdAt: { gte: from, lte: to }, deletedAt: null },
      }),
    ]);

    return {
      revenue: revenue._sum.total ?? 0,
      orders,
      delivered,
      cancelled,
      newCustomers,
      averageBasket: Math.round(revenue._avg.total ?? 0),
    };
  }

  /** Répartition des commandes par statut. */
  async statusBreakdown(from: Date, to: Date) {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      where: { createdAt: { gte: from, lte: to }, deletedAt: null },
      _count: { _all: true },
    });

    return rows.map((row) => ({ status: toWire(row.status), count: row._count._all }));
  }

  /** Répartition des encaissements par moyen de paiement. */
  async paymentBreakdown(from: Date, to: Date) {
    const rows = await this.prisma.payment.groupBy({
      by: ['method'],
      where: { createdAt: { gte: from, lte: to }, status: PaymentStatus.PAID },
      _count: { _all: true },
      _sum: { amount: true },
    });

    return rows.map((row) => ({
      method: toWire(row.method),
      count: row._count._all,
      amount: row._sum.amount ?? 0,
    }));
  }

  /**
   * Meilleures ventes.
   * Le regroupement porte sur les lignes de commande (et non sur la carte
   * actuelle) : un plat retiré du menu reste dans les statistiques.
   */
  async topProducts(from: Date, to: Date, limit = 10) {
    const rows = await this.prisma.orderItem.groupBy({
      by: ['menuItemId', 'name'],
      where: {
        order: {
          createdAt: { gte: from, lte: to },
          status: { notIn: [OrderStatus.CANCELLED] },
          deletedAt: null,
        },
      },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: limit,
    });

    const ids = rows.map((row) => row.menuItemId).filter((id): id is string => Boolean(id));
    const images = ids.length
      ? await this.prisma.menuItem.findMany({
          where: { id: { in: ids } },
          select: { id: true, imageUrl: true },
        })
      : [];
    const imageById = new Map(images.map((image) => [image.id, image.imageUrl]));

    return rows.map((row) => ({
      menuItemId: row.menuItemId ?? '',
      name: row.name,
      imageUrl: row.menuItemId ? (imageById.get(row.menuItemId) ?? null) : null,
      ordersCount: row._sum.quantity ?? 0,
      revenue: row._sum.lineTotal ?? 0,
    }));
  }

  /** Vue d'ensemble de la flotte. */
  async driverOverview() {
    const [active, available, ongoing] = await Promise.all([
      this.prisma.driverProfile.count({ where: { isOnline: true, user: { deletedAt: null } } }),
      this.prisma.driverProfile.count({
        where: { isOnline: true, isAvailable: true, user: { deletedAt: null } },
      }),
      this.prisma.delivery.count({
        where: {
          status: {
            in: [
              DeliveryStatus.ASSIGNED,
              DeliveryStatus.ACCEPTED,
              DeliveryStatus.ARRIVED_AT_RESTAURANT,
              DeliveryStatus.PICKED_UP,
              DeliveryStatus.IN_TRANSIT,
              DeliveryStatus.ARRIVED_AT_CUSTOMER,
            ],
          },
        },
      }),
    ]);

    return { activeDrivers: active, availableDrivers: available, ongoingDeliveries: ongoing };
  }

  /** Statistiques de livraison : délais et taux de réussite. */
  async deliveryStats(from: Date, to: Date) {
    const [delivered, failed, durations] = await Promise.all([
      this.prisma.delivery.count({
        where: { status: DeliveryStatus.DELIVERED, deliveredAt: { gte: from, lte: to } },
      }),
      this.prisma.delivery.count({
        where: { status: DeliveryStatus.FAILED, failedAt: { gte: from, lte: to } },
      }),
      this.prisma.$queryRaw<{ minutes: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("deliveredAt" - "assignedAt")) / 60)::float AS minutes
        FROM deliveries
        WHERE "deliveredAt" IS NOT NULL
          AND "assignedAt" IS NOT NULL
          AND "deliveredAt" >= ${from}
          AND "deliveredAt" <= ${to}
          AND ${restaurantFilterViaOrder('"orderId"')}
      `,
    ]);

    const attempted = delivered + failed;

    return {
      delivered,
      failed,
      successRate: attempted > 0 ? Math.round((delivered / attempted) * 100) : 100,
      averageMinutes: Math.round(durations[0]?.minutes ?? 0),
    };
  }

  /** Rapport complet, tel que consommé par l'écran « Rapports ». */
  async report(input: { from?: string; to?: string; period?: string }) {
    const range = this.resolveRange(input);

    const [series, totals, paymentBreakdown, topProducts, statusBreakdown, delivery] =
      await Promise.all([
        this.series(range),
        this.totals(range.from, range.to),
        this.paymentBreakdown(range.from, range.to),
        this.topProducts(range.from, range.to),
        this.statusBreakdown(range.from, range.to),
        this.deliveryStats(range.from, range.to),
      ]);

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        period: range.period,
      },
      series,
      totals,
      paymentBreakdown,
      topProducts,
      statusBreakdown,
      delivery,
    };
  }

  /** Variation en pourcentage entre deux périodes. */
  changePercent(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  }

  private formatBucket(date: Date, period: ReportPeriod): string {
    const formatter =
      period === 'yearly'
        ? new Intl.DateTimeFormat('fr-FR', { year: 'numeric', timeZone: 'UTC' })
        : period === 'monthly'
          ? new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit', timeZone: 'UTC' })
          : new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', timeZone: 'UTC' });

    return formatter.format(date);
  }
}
