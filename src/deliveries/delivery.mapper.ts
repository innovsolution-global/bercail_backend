import {
  Delivery,
  DeliveryEvent,
  DriverProfile,
  Order,
  Prisma,
  User,
} from '@prisma/client';
import { toWire } from '../common/utils/wire-enum.util';

export type DeliveryWithRelations = Delivery & {
  driver?: (DriverProfile & { user?: Pick<User, 'firstName' | 'lastName' | 'phone'> | null }) | null;
  order?:
    | (Order & {
        customer?: Pick<User, 'id' | 'firstName' | 'lastName' | 'phone'> | null;
        items?: { quantity: number; name: string; unitPrice: number; lineTotal: number }[];
      })
    | null;
  events?: DeliveryEvent[];
};

function addressFromOrder(order: DeliveryWithRelations['order']) {
  const snapshot = order?.addressSnapshot as Prisma.JsonObject | null | undefined;
  if (!snapshot) return null;

  return {
    id: (snapshot.id as string) ?? '',
    label: (snapshot.label as string) ?? '',
    street: (snapshot.street as string) ?? '',
    district: (snapshot.district as string) ?? '',
    city: (snapshot.city as string) ?? '',
    latitude: (snapshot.latitude as number | null) ?? null,
    longitude: (snapshot.longitude as number | null) ?? null,
    instructions: (snapshot.instructions as string | null) ?? null,
    phone: (snapshot.phone as string | null) ?? null,
    isDefault: false,
  };
}

/** Vue back-office d'une livraison. */
export function toDeliveryDto(delivery: DeliveryWithRelations) {
  const driverUser = delivery.driver?.user;

  return {
    id: delivery.id,
    orderId: delivery.orderId,
    orderReference: delivery.order?.reference ?? '',
    customerName: delivery.order?.customer
      ? `${delivery.order.customer.firstName} ${delivery.order.customer.lastName}`.trim()
      : '',
    customerPhone: delivery.order?.customer?.phone ?? '',
    driverId: delivery.driverId,
    driverName: driverUser ? `${driverUser.firstName} ${driverUser.lastName}`.trim() : null,
    driverPhone: driverUser?.phone ?? null,
    status: toWire(delivery.status),
    address: addressFromOrder(delivery.order),
    assignedAt: delivery.assignedAt?.toISOString() ?? null,
    acceptedAt: delivery.acceptedAt?.toISOString() ?? null,
    pickedUpAt: delivery.pickedUpAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    estimatedArrivalAt: delivery.estimatedArrivalAt?.toISOString() ?? null,
    distanceKm: delivery.distanceMeters !== null ? delivery.distanceMeters / 1000 : null,
    currentPosition:
      delivery.driver?.lastLatitude !== null &&
      delivery.driver?.lastLatitude !== undefined &&
      delivery.driver?.lastLongitude !== null &&
      delivery.driver?.lastLongitude !== undefined
        ? {
            latitude: delivery.driver.lastLatitude,
            longitude: delivery.driver.lastLongitude,
            updatedAt: delivery.driver.lastPositionAt?.toISOString(),
          }
        : null,
    failureReason: delivery.failureReason,
    reassignmentCount: delivery.reassignmentCount,
    createdAt: delivery.createdAt.toISOString(),
  };
}

/**
 * Vue livreur — la « course ».
 *
 * Elle contient tout ce dont le livreur a besoin pour travailler, et rien
 * de plus : pas l'e-mail du client, pas son historique, pas les autres
 * commandes. Le montant à encaisser n'apparaît que pour un paiement à la
 * livraison.
 */
export function toDriverDeliveryDto(delivery: DeliveryWithRelations) {
  const order = delivery.order;
  const isCashOnDelivery = order?.paymentMethod === 'CASH_ON_DELIVERY';

  return {
    id: delivery.id,
    orderId: delivery.orderId,
    orderReference: order?.reference ?? '',
    status: toWire(delivery.status),
    orderStatus: order ? toWire(order.status) : null,
    customer: {
      firstName: order?.customer?.firstName ?? '',
      phone: order?.customer?.phone ?? '',
    },
    address: addressFromOrder(order),
    items: (order?.items ?? []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
    })),
    itemsCount: (order?.items ?? []).reduce((total, item) => total + item.quantity, 0),
    /** Somme à encaisser : nulle si la commande est déjà payée. */
    amountToCollect: isCashOnDelivery && order?.paymentStatus !== 'PAID' ? (order?.total ?? 0) : 0,
    paymentMethod: order ? toWire(order.paymentMethod) : null,
    paymentStatus: order ? toWire(order.paymentStatus) : null,
    note: order?.note ?? null,
    assignedAt: delivery.assignedAt?.toISOString() ?? null,
    acceptedAt: delivery.acceptedAt?.toISOString() ?? null,
    pickedUpAt: delivery.pickedUpAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    estimatedArrivalAt: delivery.estimatedArrivalAt?.toISOString() ?? null,
    distanceKm: delivery.distanceMeters !== null ? delivery.distanceMeters / 1000 : null,
    events: (delivery.events ?? []).map((event) => ({
      status: toWire(event.status),
      at: event.createdAt.toISOString(),
      comment: event.comment,
    })),
    createdAt: delivery.createdAt.toISOString(),
  };
}

export const DELIVERY_INCLUDE = {
  driver: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } },
  order: {
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      items: { select: { name: true, quantity: true, unitPrice: true, lineTotal: true } },
    },
  },
} satisfies Prisma.DeliveryInclude;
