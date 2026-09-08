import { Prisma } from '@prisma/client';
import { restaurantContext } from './restaurant-context';

/**
 * Cloisonnement des requêtes SQL écrites à la main.
 *
 * Le client Prisma filtre automatiquement les requêtes qu'il compose
 * lui-même, mais une requête brute lui échappe par nature : elle part
 * telle quelle vers PostgreSQL. Les séries temporelles et les agrégats des
 * rapports en sont faits — et sans ce fragment, une courbe afficherait le
 * chiffre d'affaires de **tous** les établissements pendant que
 * l'indicateur juste à côté n'afficherait que celui du restaurant
 * consulté. Deux nombres contradictoires sur le même écran, et le mauvais
 * est le plus gros.
 *
 * Le paramètre reste lié plutôt qu'interpolé : la valeur ne touche jamais
 * le texte de la requête.
 *
 * @param column Colonne portant le rattachement, qualifiée si la requête
 *               joint plusieurs tables — par exemple `o."restaurantId"`.
 */
export function restaurantFilter(column = '"restaurantId"'): Prisma.Sql {
  const restaurantId = restaurantContext.activeRestaurantId();

  // Aucun périmètre : la condition doit rester vraie sans rien filtrer.
  if (!restaurantId) return Prisma.sql`TRUE`;

  return Prisma.sql`${Prisma.raw(column)} = ${restaurantId}`;
}

/**
 * Variante pour une table qui ne porte pas le rattachement elle-même.
 *
 * Une livraison, par exemple, appartient à sa commande : c'est là qu'il
 * faut aller chercher l'établissement.
 *
 * @param foreignKey Colonne pointant vers la commande, ex. `d."orderId"`.
 */
export function restaurantFilterViaOrder(foreignKey: string): Prisma.Sql {
  const restaurantId = restaurantContext.activeRestaurantId();
  if (!restaurantId) return Prisma.sql`TRUE`;

  return Prisma.sql`EXISTS (
    SELECT 1 FROM orders o
     WHERE o.id = ${Prisma.raw(foreignKey)}
       AND o."restaurantId" = ${restaurantId}
  )`;
}
