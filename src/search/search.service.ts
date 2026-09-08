import { Injectable } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { DELIVERY_ACTIVE } from '../deliveries/delivery-status';

/**
 * Recherche globale.
 *
 * Le périmètre dépend du rôle, et il est décidé ici :
 *  - CUSTOMER : la carte, et ses propres commandes ;
 *  - DRIVER : ses propres courses ;
 *  - ADMIN / SUPER_ADMIN : commandes, clients, livreurs, plats.
 *
 * Un client qui chercherait « Diallo » ne peut pas remonter la fiche
 * d'un autre client : la requête ne l'interroge tout simplement pas.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(user: AuthenticatedUser, term: string) {
    const query = term.trim();
    if (query.length < 2) {
      return { orders: [], customers: [], drivers: [], menuItems: [] };
    }

    switch (user.role) {
      case Role.CUSTOMER:
        return this.searchForCustomer(user.id, query);
      case Role.DRIVER:
        return this.searchForDriver(user.driverProfileId ?? '', query);
      default:
        return this.searchForBackOffice(query, user.permissions);
    }
  }

  private async searchForCustomer(userId: string, query: string) {
    const [menuItems, orders] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: {
          deletedAt: null,
          isAvailable: true,
          category: { isActive: true },
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { shortDescription: { contains: query, mode: 'insensitive' } },
            { ingredients: { has: query } },
          ],
        },
        select: { id: true, name: true, price: true, promoPrice: true, imageUrl: true },
        take: 10,
      }),
      this.prisma.order.findMany({
        where: {
          customerId: userId,
          deletedAt: null,
          reference: { contains: query, mode: 'insensitive' },
        },
        select: { id: true, reference: true, total: true, status: true },
        take: 5,
      }),
    ]);

    return {
      menuItems: menuItems.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.promoPrice ?? item.price,
        imageUrl: item.imageUrl,
      })),
      orders: orders.map((order) => ({
        id: order.id,
        reference: order.reference,
        total: order.total,
        status: toWire(order.status),
      })),
      customers: [],
      drivers: [],
    };
  }

  private async searchForDriver(driverProfileId: string, query: string) {
    const deliveries = await this.prisma.delivery.findMany({
      where: {
        driverId: driverProfileId,
        order: { reference: { contains: query, mode: 'insensitive' } },
      },
      include: { order: { select: { id: true, reference: true, total: true, status: true } } },
      take: 10,
    });

    return {
      orders: deliveries.map((delivery) => ({
        id: delivery.order.id,
        deliveryId: delivery.id,
        reference: delivery.order.reference,
        total: delivery.order.total,
        status: toWire(delivery.order.status),
      })),
      customers: [],
      drivers: [],
      menuItems: [],
    };
  }

  private async searchForBackOffice(query: string, permissions: string[]) {
    const can = (permission: string) => permissions.length === 0 || permissions.includes(permission);

    const [orders, customers, drivers, menuItems] = await Promise.all([
      can('ORDERS_READ')
        ? this.prisma.order.findMany({
            where: {
              deletedAt: null,
              OR: [
                { reference: { contains: query, mode: 'insensitive' } },
                { customer: { firstName: { contains: query, mode: 'insensitive' } } },
                { customer: { lastName: { contains: query, mode: 'insensitive' } } },
                { customer: { phone: { contains: query } } },
              ],
            },
            include: { customer: { select: { firstName: true, lastName: true } } },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : [],
      can('CUSTOMERS_READ')
        ? this.prisma.user.findMany({
            where: {
              role: Role.CUSTOMER,
              deletedAt: null,
              OR: [
                { firstName: { contains: query, mode: 'insensitive' } },
                { lastName: { contains: query, mode: 'insensitive' } },
                { phone: { contains: query } },
                { email: { contains: query, mode: 'insensitive' } },
              ],
            },
            select: { id: true, firstName: true, lastName: true, phone: true },
            take: 5,
          })
        : [],
      can('DRIVERS_READ')
        ? this.prisma.driverProfile.findMany({
            where: {
              user: { deletedAt: null },
              OR: [
                { driverCode: { contains: query, mode: 'insensitive' } },
                { user: { firstName: { contains: query, mode: 'insensitive' } } },
                { user: { lastName: { contains: query, mode: 'insensitive' } } },
              ],
            },
            include: { user: { select: { firstName: true, lastName: true } } },
            take: 5,
          })
        : [],
      can('MENU_READ')
        ? this.prisma.menuItem.findMany({
            where: { deletedAt: null, name: { contains: query, mode: 'insensitive' } },
            select: { id: true, name: true, price: true },
            take: 5,
          })
        : [],
    ]);

    return {
      orders: orders.map((order) => ({
        id: order.id,
        reference: order.reference,
        customerName: order.customer
          ? `${order.customer.firstName} ${order.customer.lastName}`.trim()
          : '',
        total: order.total,
        status: toWire(order.status),
      })),
      customers: customers.map((customer) => ({
        id: customer.id,
        fullName: `${customer.firstName} ${customer.lastName}`.trim(),
        phone: customer.phone,
      })),
      drivers: drivers.map((driver) => ({
        id: driver.id,
        fullName: `${driver.user.firstName} ${driver.user.lastName}`.trim(),
        zone: driver.zone,
      })),
      menuItems: menuItems.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
      })),
    };
  }

  /** Compteurs rapides pour la barre supérieure du back-office. */
  async quickCounts() {
    const [pendingOrders, activeDeliveries, unavailableItems] = await Promise.all([
      this.prisma.order.count({ where: { status: OrderStatus.PENDING, deletedAt: null } }),
      this.prisma.delivery.count({ where: { status: { in: DELIVERY_ACTIVE } } }),
      this.prisma.menuItem.count({ where: { isAvailable: false, deletedAt: null } }),
    ]);

    return { pendingOrders, activeDeliveries, unavailableItems };
  }
}
