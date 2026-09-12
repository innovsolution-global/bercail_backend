import { DeliveryStatus, OrderStatus, OrderType, Role } from '@prisma/client';
import type { Permission } from '../common/constants/permissions.constant';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

/**
 * Machine à états d'une commande.
 *
 * Le backend est seul juge de ce qui peut suivre quoi. Ni l'application
 * mobile ni le back-office ne « posent » un statut : ils demandent une
 * transition, qui est acceptée ou refusée ici.
 *
 * Progression nominale :
 *   PENDING → CONFIRMED → PREPARING → READY → ASSIGNED
 *           → OUT_FOR_DELIVERY → DELIVERED
 *
 * En retrait (PICKUP), la commande passe de READY à DELIVERED sans
 * livraison : c'est le client qui vient chercher son repas.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [
    OrderStatus.ASSIGNED,
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.ASSIGNED]: [
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.READY,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

/** Statuts terminaux : plus aucune transition n'est possible. */
export const TERMINAL_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.CANCELLED];

/** Statuts à partir desquels le client ne peut plus annuler seul. */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

/**
 * Permission exigée pour chaque transition demandée par le back-office.
 * Faire avancer une commande et l'annuler ne relèvent pas du même droit.
 */
export const TRANSITION_PERMISSION: Partial<Record<OrderStatus, Permission>> = {
  [OrderStatus.CONFIRMED]: 'ORDERS_UPDATE_STATUS',
  [OrderStatus.PREPARING]: 'ORDERS_UPDATE_STATUS',
  [OrderStatus.READY]: 'ORDERS_UPDATE_STATUS',
  [OrderStatus.ASSIGNED]: 'ORDERS_ASSIGN_DRIVER',
  [OrderStatus.OUT_FOR_DELIVERY]: 'ORDERS_UPDATE_STATUS',
  [OrderStatus.DELIVERED]: 'ORDERS_UPDATE_STATUS',
  [OrderStatus.CANCELLED]: 'ORDERS_CANCEL',
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  [OrderStatus.PENDING]: 'en attente',
  [OrderStatus.CONFIRMED]: 'confirmée',
  [OrderStatus.PREPARING]: 'en préparation',
  [OrderStatus.READY]: 'prête',
  [OrderStatus.ASSIGNED]: 'attribuée à un livreur',
  [OrderStatus.OUT_FOR_DELIVERY]: 'en cours de livraison',
  [OrderStatus.DELIVERED]: 'livrée',
  [OrderStatus.CANCELLED]: 'annulée',
};

export function statusLabel(status: OrderStatus): string {
  return STATUS_LABELS[status];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Valide une transition et lève une erreur explicite si elle est refusée.
 * Le message nomme les deux statuts : un gestionnaire doit comprendre
 * pourquoi son clic n'a rien fait.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus, type: OrderType): void {
  if (from === to) {
    throw AppException.conflict(
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      `La commande est déjà ${statusLabel(to)}.`,
    );
  }

  if (!canTransition(from, to)) {
    throw AppException.conflict(
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      `Une commande ${statusLabel(from)} ne peut pas passer à « ${statusLabel(to)} ».`,
      { from, to },
    );
  }

  // Une commande livrée à domicile passe forcément par un livreur.
  if (type === OrderType.DELIVERY && from === OrderStatus.READY && to === OrderStatus.DELIVERED) {
    throw AppException.conflict(
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      'Une commande en livraison doit être attribuée à un livreur avant d’être marquée livrée.',
    );
  }

  // À l'inverse, une commande prise au restaurant n'a pas de livreur à
  // assigner — qu'elle soit emportée ou consommée sur place.
  if (
    type !== OrderType.DELIVERY &&
    (to === OrderStatus.ASSIGNED || to === OrderStatus.OUT_FOR_DELIVERY)
  ) {
    throw AppException.conflict(
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      type === OrderType.DINE_IN
        ? 'Une commande servie sur place ne se livre pas.'
        : 'Une commande à emporter ne se livre pas.',
    );
  }
}

/**
 * Transitions qui appartiennent au livreur une fois la course confiée.
 *
 * Tant que personne ne porte la commande, le back-office pilote tout. Dès
 * qu'un livreur l'a acceptée, la suite décrit **ce qu'il fait** : il a
 * récupéré le repas, il l'a remis. Laisser le back-office poser ces
 * statuts en parallèle produit deux récits d'une même course — et le
 * mauvais est celui qui décide, puisque « livrée » déclenche
 * l'encaissement à la livraison.
 *
 * La remise, en particulier, est prouvée par le code du client. Un clic
 * depuis un bureau ne prouve rien.
 */
const DRIVER_OWNED_TRANSITIONS: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

/**
 * Refuse au back-office une transition qui revient au livreur.
 *
 * Reprendre la main reste possible : détacher le livreur ramène la
 * commande à « prête », et l'annulation n'est jamais bloquée. C'est la
 * porte de sortie quand un téléphone tombe en panne.
 */
export function assertNotDriverOwned(
  target: OrderStatus,
  delivery: { driverId: string | null; status: DeliveryStatus } | null,
): void {
  if (!delivery?.driverId) return;
  if (!DRIVER_OWNED_TRANSITIONS.includes(target)) return;

  // Une course échouée rend la main : le back-office doit pouvoir agir.
  if (delivery.status === DeliveryStatus.FAILED) return;

  throw AppException.conflict(
    ERROR_CODES.INVALID_STATUS_TRANSITION,
    target === OrderStatus.DELIVERED
      ? 'La remise est validée par le livreur depuis son application. Détachez le livreur si vous devez reprendre la main.'
      : 'Le livreur pilote sa course depuis son application. Détachez-le si vous devez reprendre la main.',
    { target },
  );
}

/** Statuts qu'un rôle donné a le droit de demander. */
export function allowedTargetsForRole(role: Role, from: OrderStatus): OrderStatus[] {
  if (role === Role.CUSTOMER) {
    return CUSTOMER_CANCELLABLE.includes(from) ? [OrderStatus.CANCELLED] : [];
  }
  if (role === Role.DRIVER) {
    // Le livreur ne pilote pas la commande : il pilote sa livraison, et
    // c'est le service de livraison qui répercute sur la commande.
    return [];
  }
  return ORDER_TRANSITIONS[from] ?? [];
}
