import {
  Address,
  Delivery,
  DriverProfile,
  Order,
  OrderItem,
  OrderItemOption,
  OrderStatusHistory,
  Payment,
  Prisma,
  User,
} from '@prisma/client';
import { toWire } from '../common/utils/wire-enum.util';

/**
 * Sérialisation des commandes.
 *
 * Deux formes : `OrderSummary` pour les listes (léger, suffisant pour un
 * tableau) et `Order` pour le détail. Le back-office React et
 * l'application Flutter consomment exactement la même structure.
 */

type DeliveryWithDriver = Delivery & {
  driver?: (DriverProfile & { user?: Pick<User, 'firstName' | 'lastName' | 'phone'> | null }) | null;
};

/**
 * Ligne de liste : seules les quantités sont chargées, pas le détail des
 * articles. C'est ce qui permet à une page de 20 commandes de ne pas
 * ramener 200 lignes d'options.
 */
export type OrderSummaryRow = Order & {
  customer?: Pick<User, 'id' | 'firstName' | 'lastName' | 'phone' | 'email'> | null;
  delivery?: DeliveryWithDriver | null;
  items?: { quantity: number }[];
  _count?: { items: number };
};

/** Commande complète, telle que chargée pour un détail ou un suivi. */
export type OrderWithRelations = Omit<OrderSummaryRow, 'items'> & {
  delivery?: DeliveryWithDriver | null;
  address?: Address | null;
  servedBy?: Pick<User, 'firstName' | 'lastName'> | null;
  items?: (OrderItem & { options: OrderItemOption[] })[];
  history?: (OrderStatusHistory & { actor?: Pick<User, 'firstName' | 'lastName'> | null })[];
  payment?: Payment | null;
  /** La maison qui prépare : de quoi la nommer et la poser sur un plan. */
  restaurant?: { id: string; name: string; latitude: number; longitude: number } | null;
  /** L'avis du client, s'il l'a donné. */
  review?: {
    id: string;
    restaurantRating: number;
    driverRating: number | null;
    comment: string | null;
    items: { orderItemId: string; rating: number }[];
  } | null;
};

function customerName(order: OrderSummaryRow): string {
  if (order.customer) return `${order.customer.firstName} ${order.customer.lastName}`.trim();
  // Vente au comptoir : le nom donné à la caisse, ou rien du tout — un
  // client de passage n'a pas à porter la mention « supprimé ».
  if (order.channel === 'POS') return order.walkInName?.trim() || 'Client de passage';
  return 'Client supprimé';
}

function driverName(order: OrderSummaryRow): string | null {
  const user = order.delivery?.driver?.user;
  if (!user) return null;
  return `${user.firstName} ${user.lastName}`.trim();
}

function addressDto(order: OrderWithRelations) {
  // On privilégie l'instantané figé à la commande : si le client a modifié
  // son adresse depuis, la commande garde celle du jour de la livraison.
  const snapshot = order.addressSnapshot as Prisma.JsonObject | null;
  if (snapshot) {
    return {
      id: (snapshot.id as string) ?? order.addressId ?? '',
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

  if (!order.address) return null;

  return {
    id: order.address.id,
    label: order.address.label,
    street: order.address.street,
    district: order.address.district,
    city: order.address.city,
    latitude: order.address.latitude,
    longitude: order.address.longitude,
    instructions: order.address.instructions,
    phone: order.address.phone,
    isDefault: order.address.isDefault,
  };
}

export function toOrderSummary(order: OrderSummaryRow) {
  return {
    id: order.id,
    reference: order.reference,
    customerId: order.customerId,
    customerName: customerName(order),
    customerPhone: order.customer?.phone ?? order.walkInPhone ?? '',
    channel: toWire(order.channel),
    tableNumber: order.tableNumber,
    type: toWire(order.type),
    status: toWire(order.status),
    itemsCount:
      order._count?.items ??
      order.items?.reduce((total, item) => total + item.quantity, 0) ??
      0,
    total: order.total,
    paymentMethod: toWire(order.paymentMethod),
    paymentStatus: toWire(order.paymentStatus),
    driverId: order.delivery?.driverId ?? null,
    driverName: driverName(order),
    createdAt: order.createdAt.toISOString(),
    /*
     * Les lignes, en version courte.
     *
     * Le détail en rend bien davantage — prix, options, notes. Ici on
     * se limite à ce qu'une vignette et un résumé demandent : alourdir
     * une liste de vingt commandes des options de chaque plat coûterait
     * cher pour rien.
     */
    items: (order.items ?? []).map((item) => ({
      menuItemId: 'menuItemId' in item ? item.menuItemId : null,
      name: 'name' in item ? item.name : '',
      imageUrl: 'imageUrl' in item ? item.imageUrl : null,
      quantity: item.quantity,
    })),
  };
}

/** Détail complet d'une commande. */
export function toOrderDetail(order: OrderWithRelations) {
  return {
    ...toOrderSummary(order),
    items: (order.items ?? []).map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      name: item.name,
      imageUrl: item.imageUrl,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      note: item.note,
      lineTotal: item.lineTotal,
      options: item.options.map((option) => ({
        /*
         * L'identifiant de l'option, pour **recommander à l'identique**.
         *
         * Sans lui, l'application ne pouvait renvoyer que le plat, nu :
         * le serveur exigeait alors de rechoisir « Accompagnement », et
         * le client relisait « Riz gras » à l'écran sans pouvoir le
         * redemander. Nul si l'option a disparu de la carte depuis — le
         * serveur redemandera alors un choix, et ce sera juste.
         */
        id: option.optionId,
        groupName: option.groupName,
        optionName: option.optionName,
        extraPrice: option.extraPrice,
      })),
    })),
    address: addressDto(order),
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    promotionCode: order.promotionCode,
    note: order.note,
    history: (order.history ?? []).map((event) => ({
      status: toWire(event.status),
      at: event.createdAt.toISOString(),
      comment: event.comment,
      actorName: event.actor ? `${event.actor.firstName} ${event.actor.lastName}`.trim() : null,
    })),
    amountReceived: order.amountReceived,
    changeGiven: order.changeGiven,
    servedByName: order.servedBy
      ? `${order.servedBy.firstName} ${order.servedBy.lastName}`.trim()
      : null,
    paymentId: order.payment?.id ?? null,
    deliveryId: order.delivery?.id ?? null,
    estimatedReadyAt: order.estimatedReadyAt?.toISOString() ?? null,
    estimatedDeliveryAt: order.estimatedDeliveryAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    cancellationReason: order.cancellationReason,
    /*
     * L'avis, s'il a été donné : l'application affiche alors les étoiles
     * laissées plutôt que de redemander. Nul tant qu'il ne l'est pas — et
     * c'est le statut « livrée » qui dit si on peut le donner.
     */
    review: order.review
      ? {
          id: order.review.id,
          restaurantRating: order.review.restaurantRating,
          driverRating: order.review.driverRating,
          comment: order.review.comment,
          items: order.review.items,
        }
      : null,
    updatedAt: order.updatedAt.toISOString(),
  };
}

/**
 * Vue « suivi de commande » pour le client.
 *
 * Elle ne contient que ce dont l'écran de suivi a besoin — pas les
 * coordonnées complètes du livreur, seulement son prénom et son numéro.
 */
export function toOrderTracking(order: OrderWithRelations) {
  const delivery = order.delivery;
  const driver = delivery?.driver;

  return {
    id: order.id,
    reference: order.reference,
    status: toWire(order.status),
    type: toWire(order.type),
    total: order.total,
    paymentStatus: toWire(order.paymentStatus),
    createdAt: order.createdAt.toISOString(),
    estimatedReadyAt: order.estimatedReadyAt?.toISOString() ?? null,
    estimatedDeliveryAt: order.estimatedDeliveryAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    address: addressDto(order),
    /*
     * La maison qui prépare, avec sa position : le plan du suivi doit
     * montrer d'où part le sac. L'application posait le repère de la
     * maison **servie au client** — qui n'est plus forcément celle de
     * la commande, si son adresse par défaut a changé entre-temps.
     */
    restaurant: order.restaurant
      ? {
          id: order.restaurant.id,
          name: order.restaurant.name,
          latitude: order.restaurant.latitude,
          longitude: order.restaurant.longitude,
        }
      : null,
    history: (order.history ?? []).map((event) => ({
      status: toWire(event.status),
      at: event.createdAt.toISOString(),
      comment: event.comment,
    })),
    delivery: delivery
      ? {
          id: delivery.id,
          status: toWire(delivery.status),
          assignedAt: delivery.assignedAt?.toISOString() ?? null,
          pickedUpAt: delivery.pickedUpAt?.toISOString() ?? null,
          deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
          estimatedArrivalAt: delivery.estimatedArrivalAt?.toISOString() ?? null,
          driver: driver
            ? {
                firstName: driver.user?.firstName ?? '',
                phone: driver.user?.phone ?? '',
                vehicleType: toWire(driver.vehicleType),
                driverCode: driver.driverCode,
                rating: driver.rating,
                position:
                  driver.lastLatitude !== null && driver.lastLongitude !== null
                    ? {
                        latitude: driver.lastLatitude,
                        longitude: driver.lastLongitude,
                        updatedAt: driver.lastPositionAt?.toISOString() ?? null,
                      }
                    : null,
              }
            : null,
        }
      : null,
  };
}

/** Relations à charger pour un détail de commande. */
export const ORDER_DETAIL_INCLUDE = {
  customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
  servedBy: { select: { firstName: true, lastName: true } },
  address: true,
  restaurant: { select: { id: true, name: true, latitude: true, longitude: true } },
  review: {
    select: {
      id: true,
      restaurantRating: true,
      driverRating: true,
      comment: true,
      items: { select: { orderItemId: true, rating: true } },
    },
  },
  items: { include: { options: true } },
  history: {
    include: { actor: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  },
  payment: true,
  delivery: {
    include: {
      driver: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } },
    },
  },
} satisfies Prisma.OrderInclude;

/** Relations minimales pour une liste. */
export const ORDER_SUMMARY_INCLUDE = {
  customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
  delivery: {
    include: {
      driver: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } },
    },
  },
  /*
   * Juste de quoi dessiner une carte de liste : la quantité pour le
   * compte, le nom pour le résumé, l'image pour la vignette, et
   * l'identifiant du plat pour « Recommander ».
   *
   * La liste n'en rendait que la quantité. Trois conséquences, toutes
   * silencieuses : la carte s'affichait sans photo, sa ligne de résumé
   * restait vide, et « Recommander » parcourait une liste de lignes
   * vide — il ouvrait donc un panier vide sans le moindre message.
   */
  items: {
    select: { quantity: true, name: true, imageUrl: true, menuItemId: true },
  },
} satisfies Prisma.OrderInclude;
