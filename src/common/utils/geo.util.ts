/**
 * Calculs géographiques.
 *
 * Le suivi de livraison n'a pas besoin d'une projection cartographique :
 * la distance à vol d'oiseau suffit à classer les livreurs disponibles et
 * à estimer une durée. Toute distance est exprimée en mètres (entier).
 */

const EARTH_RADIUS_METERS = 6_371_000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Distance orthodromique (formule de haversine), en mètres. */
export function distanceMeters(from: Coordinates, to: Coordinates): number {
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLon / 2) ** 2;

  return Math.round(EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function distanceKm(from: Coordinates, to: Coordinates): number {
  return Math.round((distanceMeters(from, to) / 1000) * 10) / 10;
}

/**
 * Durée de trajet estimée, en minutes.
 *
 * Vitesse moyenne volontairement basse (18 km/h) : à Conakry, une moto
 * en heure de pointe ne roule pas à 40. Mieux vaut annoncer large.
 */
export function estimatedMinutes(meters: number, averageSpeedKmh = 18): number {
  const hours = meters / 1000 / averageSpeedKmh;
  return Math.max(1, Math.round(hours * 60));
}

export function isValidCoordinates(value: Partial<Coordinates> | null | undefined): value is Coordinates {
  if (!value) return false;
  const { latitude, longitude } = value;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
