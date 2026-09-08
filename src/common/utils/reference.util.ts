import { randomInt } from 'node:crypto';

/**
 * Génération des références lisibles par un humain.
 *
 * Une référence de commande est lue au téléphone entre un client, un
 * gestionnaire et un livreur : elle doit être courte, sans caractères
 * ambigus, et unique.
 */

/** Alphabet sans 0/O ni 1/I : impossible de confondre à l'oral. */
const UNAMBIGUOUS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSuffix(length: number): string {
  let suffix = '';
  for (let index = 0; index < length; index += 1) {
    suffix += UNAMBIGUOUS[randomInt(0, UNAMBIGUOUS.length)];
  }
  return suffix;
}

/** Ex. `BRC-240903-K7M2`. Le jour permet de trier à l'œil. */
export function generateOrderReference(prefix = 'BRC', now: Date = new Date()): string {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${prefix}-${year}${month}${day}-${randomSuffix(4)}`;
}

/** Ex. `TRX-240903-9F3KQ2`. */
export function generateTransactionRef(now: Date = new Date()): string {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `TRX-${year}${month}${day}-${randomSuffix(6)}`;
}

/**
 * Référence d'une pièce de gestion : achat, dépense, recette.
 * Ex. `DEP-260907-K7M2`. Le préfixe dit la nature du document, le jour
 * permet de retrouver une pièce en la lisant.
 */
export function generateDocumentReference(prefix: string, now: Date = new Date()): string {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${prefix}-${year}${month}${day}-${randomSuffix(4)}`;
}

/** Ex. `LIV-042` : le code affiché sur le blouson du livreur. */
export function generateDriverCode(sequence: number): string {
  return `LIV-${String(sequence).padStart(3, '0')}`;
}

/** Slug d'URL pour les catégories. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
