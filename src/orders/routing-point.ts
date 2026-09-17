import { isValidCoordinates, type Coordinates } from '../common/utils/geo.util';

type Point = { latitude?: number | null; longitude?: number | null };

function valid(point: Point | null | undefined): Coordinates | null {
  if (!point) return null;
  const candidate = { latitude: point.latitude ?? undefined, longitude: point.longitude ?? undefined };
  return isValidCoordinates(candidate) ? { latitude: candidate.latitude, longitude: candidate.longitude } : null;
}

/**
 * Où livrer une commande.
 *
 * **La position donnée avec la commande d'abord** : celle du client au
 * moment où il commande, relevée par son téléphone ou posée sur la carte.
 * C'est là qu'il est, donc là que le repas doit arriver — même s'il a
 * enregistré son adresse ailleurs. Décision du propriétaire, 15 septembre
 * 2026 : « la livraison doit se faire à la position actuelle du client ».
 *
 * À défaut, la position de l'adresse choisie, si elle en a une : c'est le
 * cas des applications qui n'envoient pas encore la leur. `null` quand ni
 * l'une ni l'autre ne situe la livraison.
 */
export function deliveryPoint(
  given: Point | null | undefined,
  address: Point | null | undefined,
): Coordinates | null {
  return valid(given) ?? valid(address);
}

/**
 * D'où se calcule la maison la plus proche, pour une commande.
 *
 * **Le point de livraison d'abord** ([[deliveryPoint]]) : c'est là que le
 * repas doit arriver chaud. Quelqu'un qui commande de chez lui, à Sonfonia,
 * est servi par la maison la plus proche de Sonfonia — pas de celle du
 * bureau où il a enregistré son adresse.
 *
 * À défaut — retrait sur place, ou commande sans point —, la position que
 * l'application a désignée pour lire la carte. `null` quand rien ne situe
 * la commande : elle revient alors à la maison qui sert ce client.
 */
export function routingPoint(
  delivery: Point | null | undefined,
  designated: Coordinates | null | undefined,
): Coordinates | null {
  return valid(delivery) ?? valid(designated);
}
