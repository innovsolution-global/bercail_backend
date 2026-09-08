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
const SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Category',
  'MenuItem',
  'Supplier',
  'StockItem',
  'StockMovement',
  'Purchase',
  'Expense',
  'Income',
  'Employee',
  'Promotion',
  'Order',
  'OpeningHour',
]);

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
          if (!restaurantId || !model || !SCOPED_MODELS.has(model)) {
            return query(args);
          }

          if (FILTERABLE_READS.has(operation)) {
            return query({
              ...args,
              where: { ...((args.where as object) ?? {}), restaurantId },
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
