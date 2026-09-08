import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

export interface IdempotentOptions {
  /** Durée de conservation de la réponse rejouable, en heures. */
  ttlHours?: number;
  /** Rendre l'en-tête `Idempotency-Key` obligatoire. */
  required?: boolean;
}

/**
 * Marque une route comme idempotente.
 *
 * Deux requêtes portant la même `Idempotency-Key` produisent une seule
 * exécution : la seconde reçoit la réponse mémorisée. Indispensable pour
 * la création de commande et le paiement sur un réseau mobile instable.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, { ttlHours: 24, required: false, ...options });
