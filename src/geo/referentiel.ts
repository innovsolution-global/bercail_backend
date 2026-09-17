import referentiel from './guinee.json';

/**
 * Découpage administratif de la Guinée — le référentiel des adresses.
 *
 * Fourni par le propriétaire le 14 septembre 2026 (`guinee.json`, gardé
 * tel quel) : sept régions et leurs trente-trois préfectures. Une adresse
 * se saisit désormais en choisissant sa **région**, puis sa **préfecture**
 * (la « ville » de l'adresse), et non plus en tapant une ville librement —
 * ce qui donnait « Conakry », « conakry » et « CKY » pour la même chose.
 *
 * **Conakry n'y figure pas.** La capitale n'est pas une préfecture mais
 * une zone spéciale, découpée en communes ; or c'est là que sont nos deux
 * maisons et la quasi-totalité des clients. Elle est donc ajoutée ici, en
 * tête, avec ses communes comme quartiers. Le fichier du propriétaire
 * n'est pas modifié : l'ajout est visible dans le code, pas noyé dans la
 * donnée.
 */
export interface Region {
  nom: string;
  /** Les préfectures — pour Conakry, la zone spéciale elle-même. */
  prefectures: readonly string[];
}

export const CONAKRY = 'Conakry';

/**
 * Les communes de la capitale : les quartiers proposés pour une adresse à
 * Conakry.
 *
 * Les treize du découpage en vigueur, et non les cinq historiques : le
 * propriétaire a repris l'application le 15 septembre 2026 — « à Conakry
 * ce n'est pas seulement les 5 communes, il y a plus que ça ». Un client
 * de Sonfonia ou de Lambanyi ne pouvait pas nommer sa commune.
 */
export const COMMUNES_DE_CONAKRY: readonly string[] = [
  'Kaloum',
  'Dixinn',
  'Matam',
  'Ratoma',
  'Matoto',
  'Lambanyi',
  'Sonfonia',
  'Gbessia',
  'Tombolia',
  'Kagbelen',
  'Sanoyah',
  'Manéah',
  'Kassa',
];

export const REGIONS: readonly Region[] = [
  { nom: CONAKRY, prefectures: [CONAKRY] },
  ...referentiel.regions.map((region) => ({
    nom: region.nom,
    prefectures: [...region.prefectures],
  })),
];

/** Toutes les villes qu'une adresse peut porter : Conakry et les préfectures. */
export const VILLES: readonly string[] = REGIONS.flatMap((region) => region.prefectures);

/** La région d'une ville, ou `null` si la ville n'est pas au référentiel. */
export function regionDe(ville: string | null | undefined): string | null {
  if (!ville) return null;
  return REGIONS.find((region) => region.prefectures.includes(ville))?.nom ?? null;
}

/** Ce que le serveur répond quand une ville n'est pas au référentiel. */
export const VILLE_INCONNUE =
  'Ville inconnue : choisissez Conakry ou l’une des préfectures de Guinée.';

/** Le référentiel tel que les applications le reçoivent. */
export function referentielGuinee() {
  return {
    pays: referentiel.pays,
    regions: REGIONS.map((region) => ({ nom: region.nom, prefectures: [...region.prefectures] })),
    communesDeConakry: [...COMMUNES_DE_CONAKRY],
  };
}
