/**
 * Nombre d'avis à partir duquel une moyenne se montre.
 *
 * Une moyenne sur un avis n'est pas une moyenne : après le premier client,
 * chaque plat affichait « 5,0 » — ou « 1,0 » — comme une vérité établie.
 * Les applications de livraison n'affichent une note qu'une fois assez
 * d'avis réunis, et disent « Nouveau » avant. En dessous de ce seuil, la
 * note reste nulle ; le nombre d'avis, lui, est toujours rendu, pour que
 * chacun voie que son avis a compté.
 */
export const MIN_REVIEWS_FOR_RATING = 5;

/** La note à enregistrer : la moyenne à une décimale, ou rien avant le seuil. */
export function displayedRating(average: number | null, reviewCount: number): number | null {
  if (average === null || reviewCount < MIN_REVIEWS_FOR_RATING) return null;
  // « 4,3 », pas « 4,333333 ».
  return Math.round(average * 10) / 10;
}
