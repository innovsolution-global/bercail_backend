/**
 * Arithmétique monétaire.
 *
 * Toute la plateforme manipule des ENTIERS en francs guinéens (GNF).
 * Aucun flottant ne doit approcher un montant : `0.1 + 0.2` n'a pas sa
 * place dans une addition de commande.
 */

export const CURRENCY = 'GNF';

export class MoneyError extends Error {}

/** Garantit qu'une valeur est un montant valide (entier positif ou nul). */
export function assertAmount(value: number, label = 'montant'): number {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Le ${label} doit être un entier en ${CURRENCY} (reçu : ${value}).`);
  }
  if (value < 0) {
    throw new MoneyError(`Le ${label} ne peut pas être négatif (reçu : ${value}).`);
  }
  return value;
}

export function sum(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/**
 * Applique un pourcentage à un montant.
 * L'arrondi est fait à l'entier inférieur : la remise ne dépasse jamais
 * le pourcentage annoncé, et le client n'est jamais surfacturé d'un franc.
 */
export function percentageOf(amount: number, percentage: number): number {
  return Math.floor((amount * percentage) / 100);
}

/** Un montant ne descend jamais sous zéro (une remise ne rembourse pas). */
export function clampToZero(amount: number): number {
  return amount < 0 ? 0 : amount;
}

/** Plafonne une remise au montant remisable et au plafond éventuel. */
export function capDiscount(discount: number, maximum: number | null | undefined): number {
  const capped = maximum !== null && maximum !== undefined ? Math.min(discount, maximum) : discount;
  return clampToZero(Math.floor(capped));
}

/** Formatage lisible pour les notifications et les libellés serveur. */
export function formatAmount(amount: number): string {
  return `${amount.toLocaleString('fr-FR').replace(/ | /g, ' ')} ${CURRENCY}`;
}
