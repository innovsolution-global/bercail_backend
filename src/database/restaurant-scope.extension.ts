import { Prisma } from '@prisma/client';
import { restaurantContext } from '../common/context/restaurant-context';

/**
 * Modèles cloisonnés par établissement.
 *
 * Ceux qui n'y figurent pas se rangent en deux familles : soit ils sont
 * communs à toute l'enseigne (comptes clients, permissions, réglages
 * système), soit ils s'atteignent toujours par un parent qui, lui, est
 * cloisonné — les options d'un plat, les lignes d'un achat, l'historique
 * d'une commande.
 */
/*
 * La carte — catégories, plats, promotions — n'y figure plus : elle est
 * **commune à toutes les maisons** depuis le 14 septembre 2026. Chaque
 * maison garde en revanche son stock, ses achats, ses dépenses et son
 * personnel, pour que les comptes restent séparés.
 */
const SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Supplier',
  'StockItem',
  'StockMovement',
  'Purchase',
  'Expense',
  'Income',
  'Employee',
  'Order',
  'OpeningHour',
]);

/**
 * Modèles cloisonnés **par leur parent**.
 *
 * Une livraison n'a pas d'établissement : elle a une commande, qui en a
 * un. Un livreur non plus : son compte en a un. Un paiement pareil. Le
 * filtre passe donc par la relation — sans quoi le tableau de bord de
 * Kipé comptait « 1 livraison en cours » pour une course partie de
 * Kaloum, et la liste des livreurs mêlait les deux maisons.
 *
 * Seules les lectures filtrables sont couvertes : une lecture par clé
 * unique ne peut pas porter de relation, et les services qui ouvrent une
 * fiche vérifient déjà eux-mêmes l'établissement. Rien n'est posé à la
 * création non plus : c'est le parent qui porte le rattachement.
 */
const SCOPED_THROUGH: Readonly<Record<string, (restaurantId: string) => Record<string, object>>> = {
  Delivery: (restaurantId) => ({ order: { restaurantId } }),
  Payment: (restaurantId) => ({ order: { restaurantId } }),
  DriverProfile: (restaurantId) => ({ user: { restaurantId } }),
};

/** Ajoute le filtre de relation sans écraser ce que la requête y mettait déjà. */
function throughRelation(
  where: Record<string, unknown>,
  relation: Record<string, object>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...where };
  for (const [key, filter] of Object.entries(relation)) {
    merged[key] = { ...((where[key] as object) ?? {}), ...filter };
  }
  return merged;
}

/** Lectures auxquelles on peut ajouter un filtre non unique. */
const FILTERABLE_READS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/** Lectures par clé unique : Prisma y refuse tout champ non unique. */
const UNIQUE_READS: ReadonlySet<string> = new Set(['findUnique', 'findUniqueOrThrow']);

/**
 * Cloisonnement des données par établissement.
 *
 * Le filtre est posé par le client lui-même, pas par les cent quatre
 * requêtes des services : c'est la seule façon d'être sûr qu'aucune ne
 * l'oublie. Même philosophie que les déclencheurs de synchronisation —
 * la garantie est structurelle, pas disciplinaire.
 *
 * Trois traitements, selon ce que Prisma autorise :
 *
 *  • **Lectures filtrables** — le `restaurantId` entre dans le `where`.
 *  • **Lectures par clé unique** — Prisma n'y accepte pas de champ non
 *    unique : on laisse passer la requête et on écarte le résultat s'il
 *    appartient à un autre établissement.
 *  • **Créations** — l'établissement est posé sur la ligne écrite, ce qui
 *    évite qu'un oubli de service crée une donnée orpheline.
 *
 * `update`, `delete` et `upsert` par identifiant ne sont pas interceptés :
 * Prisma n'y accepte pas non plus de filtre supplémentaire. Ils restent
 * couverts en pratique parce que les services relisent toujours la ligne
 * avant de l'écrire — et cette relecture, elle, est cloisonnée.
 */
export function withRestaurantScope<T extends object>(client: T): T {
  return (client as { $extends: (ext: unknown) => T }).$extends({
    name: 'restaurantScope',
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }) {
          const restaurantId = restaurantContext.activeRestaurantId();

          // Hors requête, ou compte non cloisonné : rien à filtrer.
          if (!restaurantId || !model) return query(args);

          const through = SCOPED_THROUGH[model];
          if (through) {
            if (!FILTERABLE_READS.has(operation)) return query(args);
            return query({
              ...(args ?? {}),
              where: throughRelation((args?.where as Record<string, unknown>) ?? {}, through(restaurantId)),
            });
          }

          if (!SCOPED_MODELS.has(model)) return query(args);

          if (FILTERABLE_READS.has(operation)) {
            return query({
              ...(args ?? {}),
              where: { ...((args?.where as object) ?? {}), restaurantId },
            });
          }

          if (UNIQUE_READS.has(operation)) {
            const result = (await query(args)) as { restaurantId?: string } | null;
            if (result && result.restaurantId !== restaurantId) {
              // Vue de l'appelant, la ligne n'existe pas — plutôt qu'un
              // refus, qui révélerait qu'elle existe ailleurs.
              if (operation === 'findUniqueOrThrow') {
                throw new Prisma.PrismaClientKnownRequestError(
                  'Aucun enregistrement trouvé.',
                  { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
                );
              }
              return null;
            }
            return result;
          }

          if (operation === 'create') {
            const data = (args.data as Record<string, unknown>) ?? {};
            return query({ ...args, data: { restaurantId, ...data } });
          }

          if (operation === 'createMany') {
            const data = args.data as Record<string, unknown> | Record<string, unknown>[];
            const rows = Array.isArray(data) ? data : [data];
            return query({
              ...args,
              data: rows.map((row) => ({ restaurantId, ...row })),
            });
          }

          return query(args);
        },
      },
    },
  });
}
