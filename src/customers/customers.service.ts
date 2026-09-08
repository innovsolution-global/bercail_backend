import { Injectable } from '@nestjs/common';
import { AccountStatus, NotificationType, OrderStatus, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { CustomerQueryDto, UpdateCustomerDto } from './dto/customer.dto';

/**
 * Clients.
 *
 * Deux publics pour un seul service : le gestionnaire qui consulte et
 * modère, et le client qui gère son propre profil. Les données sensibles
 * (condensat du mot de passe, jetons) ne sont jamais sélectionnées — elles
 * ne peuvent donc pas fuir par inadvertance dans une réponse.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private readonly select = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    avatarUrl: true,
    status: true,
    createdAt: true,
    lastActivityAt: true,
    customerProfile: {
      select: {
        loyaltyPoints: true,
        ordersCount: true,
        cancelledOrders: true,
        totalSpent: true,
        lastOrderAt: true,
      },
    },
    addresses: {
      where: { deletedAt: null },
      orderBy: { isDefault: 'desc' as const },
    },
  } satisfies Prisma.UserSelect;

  // ─────────────────────────── Back-office ────────────────────────────────

  async list(query: CustomerQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.UserWhereInput = { role: Role.CUSTOMER, deletedAt: null };

    const status = parseEnum(AccountStatus, query.status);
    if (status) where.status = status;

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: this.select,
        orderBy: this.buildOrder(query),
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);
  }

  async findOne(id: string) {
    const customer = await this.prisma.user.findFirst({
      where: { id, role: Role.CUSTOMER, deletedAt: null },
      select: this.select,
    });

    if (!customer) throw AppException.notFound('Client introuvable.');

    const profile = customer.customerProfile;
    const orders = profile?.ordersCount ?? 0;

    return {
      ...this.toDto(customer),
      addresses: customer.addresses.map((address) => ({
        id: address.id,
        label: address.label,
        street: address.street,
        district: address.district,
        city: address.city,
        latitude: address.latitude,
        longitude: address.longitude,
        instructions: address.instructions,
        isDefault: address.isDefault,
      })),
      averageBasket: orders > 0 ? Math.round((profile?.totalSpent ?? 0) / orders) : 0,
      cancelledOrders: profile?.cancelledOrders ?? 0,
      lastActivityAt: customer.lastActivityAt?.toISOString() ?? null,
    };
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.user.findFirst({
      where: { id, role: Role.CUSTOMER, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Client introuvable.');

    await this.prisma.user.update({ where: { id }, data: { ...dto } });

    await this.audit.record({
      actor,
      action: 'CUSTOMER_UPDATE',
      module: 'customers',
      entityType: 'User',
      entityId: id,
      oldValue: {
        firstName: existing.firstName,
        lastName: existing.lastName,
        phone: existing.phone,
        email: existing.email,
      },
      newValue: dto,
      context,
    });

    return this.findOne(id);
  }

  /**
   * Suspension d'un client.
   *
   * Ses sessions sont fermées immédiatement. Ses commandes en cours ne
   * sont pas annulées : le repas déjà en préparation doit être livré.
   */
  async setStatus(
    id: string,
    status: string,
    actor: AuthenticatedUser,
    context: RequestContext,
    reason?: string,
  ) {
    const existing = await this.prisma.user.findFirst({
      where: { id, role: Role.CUSTOMER, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Client introuvable.');

    const target = (parseEnum(AccountStatus, status) ?? AccountStatus.ACTIVE) as AccountStatus;

    await this.prisma.user.update({ where: { id }, data: { status: target } });

    if (target !== AccountStatus.ACTIVE) {
      await this.tokens.revokeAllForUser(id);
    }

    await this.notifications.notify({
      userId: id,
      type: NotificationType.SECURITY,
      title: target === AccountStatus.SUSPENDED ? 'Compte suspendu' : 'Statut de compte modifié',
      body:
        target === AccountStatus.SUSPENDED
          ? `Votre compte a été suspendu. ${reason ?? 'Contactez le restaurant.'}`
          : 'Votre compte est de nouveau actif.',
      push: false,
    });

    await this.audit.record({
      actor,
      action: 'CUSTOMER_STATUS_UPDATE',
      module: 'customers',
      entityType: 'User',
      entityId: id,
      oldValue: { status: existing.status },
      newValue: { status: target, reason: reason ?? null },
      context,
    });

    return this.findOne(id);
  }

  /** Statistiques d'un client pour sa fiche back-office. */
  async summary(id: string) {
    const [orders, spent, lastOrder] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        where: { customerId: id, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.order.aggregate({
        _sum: { total: true },
        where: { customerId: id, status: OrderStatus.DELIVERED },
      }),
      this.prisma.order.findFirst({
        where: { customerId: id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, reference: true, total: true, status: true, createdAt: true },
      }),
    ]);

    return {
      ordersByStatus: orders.map((row) => ({
        status: toWire(row.status),
        count: row._count._all,
      })),
      totalSpent: spent._sum.total ?? 0,
      lastOrder: lastOrder
        ? {
            id: lastOrder.id,
            reference: lastOrder.reference,
            total: lastOrder.total,
            status: toWire(lastOrder.status),
            createdAt: lastOrder.createdAt.toISOString(),
          }
        : null,
    };
  }

  /** Export CSV — la liste complète, sans pagination, filtres appliqués. */
  async exportRows(query: CustomerQueryDto) {
    const result = await this.list({ ...query, page: 1, limit: 100 } as CustomerQueryDto);
    return result.data as Record<string, unknown>[];
  }

  // ───────────────────────────── Espace client ────────────────────────────

  /** Profil complet du client connecté (fidélité incluse). */
  async profile(userId: string) {
    const customer = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: this.select,
    });
    if (!customer) throw AppException.notFound('Compte introuvable.');
    return this.findOne(customer.id);
  }

  // ──────────────────────────────── Outils ────────────────────────────────

  private buildOrder(query: CustomerQueryDto): Prisma.UserOrderByWithRelationInput {
    const direction = query.sortOrder ?? 'desc';
    switch (query.sortBy) {
      case 'name':
        return { firstName: query.sortOrder ?? 'asc' };
      case 'orders':
        return { customerProfile: { ordersCount: direction } };
      case 'spent':
        return { customerProfile: { totalSpent: direction } };
      default:
        return { createdAt: direction };
    }
  }

  private toDto(customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    avatarUrl: string | null;
    status: AccountStatus;
    createdAt: Date;
    customerProfile: {
      loyaltyPoints: number;
      ordersCount: number;
      totalSpent: number;
      lastOrderAt: Date | null;
    } | null;
    addresses: { id: string; label: string; street: string; district: string; city: string; latitude: number | null; longitude: number | null; instructions: string | null; isDefault: boolean }[];
  }) {
    const defaultAddress = customer.addresses.find((address) => address.isDefault) ?? null;

    return {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      fullName: `${customer.firstName} ${customer.lastName}`.trim(),
      phone: customer.phone,
      email: customer.email,
      avatarUrl: customer.avatarUrl,
      status: toWire(customer.status),
      ordersCount: customer.customerProfile?.ordersCount ?? 0,
      totalSpent: customer.customerProfile?.totalSpent ?? 0,
      loyaltyPoints: customer.customerProfile?.loyaltyPoints ?? 0,
      lastOrderAt: customer.customerProfile?.lastOrderAt?.toISOString() ?? null,
      defaultAddress: defaultAddress
        ? {
            id: defaultAddress.id,
            label: defaultAddress.label,
            street: defaultAddress.street,
            district: defaultAddress.district,
            city: defaultAddress.city,
            latitude: defaultAddress.latitude,
            longitude: defaultAddress.longitude,
            instructions: defaultAddress.instructions,
            isDefault: true,
          }
        : null,
      createdAt: customer.createdAt.toISOString(),
    };
  }
}
