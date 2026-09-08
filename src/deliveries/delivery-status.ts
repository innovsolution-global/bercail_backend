import { DeliveryStatus } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

/**
 * Machine à états d'une livraison.
 *
 * Elle suit le trajet réel du livreur : il accepte, arrive au restaurant,
 * récupère la commande, roule, arrive chez le client, remet le repas.
 * Deux raccourcis sont tolérés parce qu'ils correspondent au terrain :
 * un livreur déjà sur place enchaîne accepter → récupérer, et un trajet
 * court se résume à récupérer → arrivé.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  [DeliveryStatus.ASSIGNED]: [DeliveryStatus.ACCEPTED, DeliveryStatus.FAILED],
  [DeliveryStatus.ACCEPTED]: [
    DeliveryStatus.ARRIVED_AT_RESTAURANT,
    DeliveryStatus.PICKED_UP,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.ARRIVED_AT_RESTAURANT]: [DeliveryStatus.PICKED_UP, DeliveryStatus.FAILED],
  [DeliveryStatus.PICKED_UP]: [
    DeliveryStatus.IN_TRANSIT,
    DeliveryStatus.ARRIVED_AT_CUSTOMER,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.IN_TRANSIT]: [DeliveryStatus.ARRIVED_AT_CUSTOMER, DeliveryStatus.FAILED],
  [DeliveryStatus.ARRIVED_AT_CUSTOMER]: [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED],
  [DeliveryStatus.DELIVERED]: [],
  [DeliveryStatus.FAILED]: [],
};

export const DELIVERY_TERMINAL: DeliveryStatus[] = [
  DeliveryStatus.DELIVERED,
  DeliveryStatus.FAILED,
];

/** Statuts pendant lesquels le livreur est mobilisé (donc indisponible). */
export const DELIVERY_ACTIVE: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.ARRIVED_AT_RESTAURANT,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
  DeliveryStatus.ARRIVED_AT_CUSTOMER,
];

const LABELS: Record<DeliveryStatus, string> = {
  [DeliveryStatus.ASSIGNED]: 'attribuée',
  [DeliveryStatus.ACCEPTED]: 'acceptée',
  [DeliveryStatus.ARRIVED_AT_RESTAURANT]: 'arrivée au restaurant',
  [DeliveryStatus.PICKED_UP]: 'commande récupérée',
  [DeliveryStatus.IN_TRANSIT]: 'en route',
  [DeliveryStatus.ARRIVED_AT_CUSTOMER]: 'arrivée chez le client',
  [DeliveryStatus.DELIVERED]: 'livrée',
  [DeliveryStatus.FAILED]: 'échouée',
};

export function deliveryStatusLabel(status: DeliveryStatus): string {
  return LABELS[status];
}

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (from === to) {
    throw AppException.conflict(
      ERROR_CODES.INVALID_DELIVERY_TRANSITION,
      `Cette livraison est déjà ${deliveryStatusLabel(to)}.`,
    );
  }

  if (!canTransitionDelivery(from, to)) {
    throw AppException.conflict(
      ERROR_CODES.INVALID_DELIVERY_TRANSITION,
      `Une livraison ${deliveryStatusLabel(from)} ne peut pas passer à « ${deliveryStatusLabel(to)} ».`,
      { from, to },
    );
  }
}

/** Horodatage à renseigner selon le statut atteint. */
export function timestampField(status: DeliveryStatus): string | null {
  const fields: Partial<Record<DeliveryStatus, string>> = {
    [DeliveryStatus.ACCEPTED]: 'acceptedAt',
    [DeliveryStatus.ARRIVED_AT_RESTAURANT]: 'arrivedAtRestaurantAt',
    [DeliveryStatus.PICKED_UP]: 'pickedUpAt',
    [DeliveryStatus.IN_TRANSIT]: 'inTransitAt',
    [DeliveryStatus.ARRIVED_AT_CUSTOMER]: 'arrivedAtCustomerAt',
    [DeliveryStatus.DELIVERED]: 'deliveredAt',
    [DeliveryStatus.FAILED]: 'failedAt',
  };
  return fields[status] ?? null;
}
