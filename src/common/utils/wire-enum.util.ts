/**
 * Traduction des énumérations entre la base et le réseau.
 *
 * Règle unique, valable pour toute l'API :
 *   - `role` et les permissions circulent en UPPER_SNAKE_CASE ;
 *   - toutes les autres énumérations circulent en lower_snake_case.
 *
 * Cette règle est ce que consomment déjà les deux frontends :
 * `'pending'`, `'cash_on_delivery'`, `'out_for_delivery'`… et `'SUPER_ADMIN'`.
 * La base, elle, reste en UPPER_SNAKE_CASE (lisible dans psql et conforme
 * aux conventions Prisma).
 */

/** Base → réseau. `OUT_FOR_DELIVERY` devient `out_for_delivery`. */
export function toWire<T extends string>(value: T): string;
export function toWire<T extends string>(value: T | null | undefined): string | null;
export function toWire<T extends string>(value: T | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toLowerCase();
}

/** Réseau → base. Accepte les deux casses pour rester tolérant en entrée. */
export function fromWire(value: string): string;
export function fromWire(value: string | null | undefined): string | null;
export function fromWire(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toUpperCase();
}

/**
 * Convertit une valeur reçue du client vers un membre d'énumération Prisma.
 * Renvoie `undefined` si la valeur n'appartient pas à l'énumération : les
 * DTO valident déjà, ceci est la deuxième barrière (filtres de listes).
 */
export function parseEnum<T extends Record<string, string>>(
  enumObject: T,
  value: unknown,
): T[keyof T] | undefined {
  if (typeof value !== 'string' || value === '' || value === 'all') return undefined;
  const normalized = value.toUpperCase();
  const values = Object.values(enumObject) as string[];
  return values.includes(normalized) ? (normalized as T[keyof T]) : undefined;
}

/** Variante liste, pour les filtres multi-valeurs (`?status=pending,ready`). */
export function parseEnumList<T extends Record<string, string>>(
  enumObject: T,
  value: unknown,
): T[keyof T][] | undefined {
  if (typeof value !== 'string' || value === '' || value === 'all') return undefined;
  const parsed = value
    .split(',')
    .map((entry) => parseEnum(enumObject, entry))
    .filter((entry): entry is T[keyof T] => entry !== undefined);
  return parsed.length > 0 ? parsed : undefined;
}

/** Liste des valeurs d'une énumération au format réseau (pour Swagger). */
export function wireValues<T extends Record<string, string>>(enumObject: T): string[] {
  return Object.values(enumObject).map((value) => value.toLowerCase());
}
