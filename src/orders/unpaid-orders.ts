import { OrderChannel, PaymentMethod, PaymentStatus, type Prisma } from '@prisma/client';

/**
 * Les commandes en ligne dont l'argent n'est pas arrivé.
 *
 * Une commande réglée par mobile money n'existe pour le restaurant qu'une
 * fois le paiement encaissé : avant, le client est encore sur la page de
 * l'opérateur, ou il y a renoncé. Ces règles vivaient chacune dans son
 * coin — et deux endroits les ignoraient : un paiement annulé laissait sa
 * commande dans le back-office, où un gérant a pu la confirmer et
 * l'envoyer en cuisine sans qu'un franc soit encaissé.
 */

/** Motif d'une commande dont le client a fermé la page de paiement. */
export const ABANDON_REASON = 'Paiement abandonné par le client';

const EXPIRY_PREFIX = 'Paiement non reçu sous';

/** Motif d'une commande expirée faute de paiement. */
export function expiryReason(delayMinutes: number): string {
  return `${EXPIRY_PREFIX} ${delayMinutes} minutes`;
}

/**
 * Annulée par le parcours de paiement, et non par une personne.
 *
 * Seules celles-là sont rétablies si l'argent arrive malgré tout : le
 * client a payé, il attend son repas. Une commande annulée par le
 * restaurant, elle, reste annulée.
 */
export function cancelledForNonPayment(reason: string | null | undefined): boolean {
  return reason === ABANDON_REASON || (reason ?? '').startsWith(EXPIRY_PREFIX);
}

/**
 * Filtre des listes du restaurant : en ligne, à régler en ligne, et
 * jamais encaissée. Une commande remboursée, elle, a existé — elle reste
 * visible.
 */
export const UNPAID_ONLINE: Prisma.OrderWhereInput = {
  channel: OrderChannel.ONLINE,
  paymentMethod: { not: PaymentMethod.CASH_ON_DELIVERY },
  paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED] },
};

/**
 * Garde des changements de statut : une commande à régler en ligne ne
 * bouge pas tant que son paiement n'est pas encaissé — remboursée non
 * plus, on ne cuisine pas ce qu'on a rendu.
 */
export function isUnpaidOnline(order: {
  channel: OrderChannel;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
}): boolean {
  return (
    order.channel === OrderChannel.ONLINE &&
    order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY &&
    order.paymentStatus !== PaymentStatus.PAID
  );
}
