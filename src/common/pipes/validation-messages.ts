/**
 * Les messages de validation, en français.
 *
 * `class-validator` écrit les siens en anglais : « property
 * confirmationCode should not exist », « code must be a string ». Ces
 * phrases remontaient telles quelles jusqu'à l'application, qui les
 * affiche sans les relire — un livreur devant sa commande a donc pu lire
 * « property confirmationCode should not exist » en plein service.
 *
 * Le reste du serveur parle français : c'est le contrat de l'API, et
 * l'application mobile s'y fie au point de n'avoir aucun message de
 * secours à afficher à la place.
 *
 * ## Ce qui est traduit, et ce qui ne l'est pas
 *
 * Les messages **écrits à la main** dans les DTO sont déjà en français —
 * « code doit être numérique. », « phone doit être un numéro valide. » —
 * et doivent passer intacts : ils sont plus précis que n'importe quelle
 * traduction générique. On ne traduit donc que ce qui **ressemble à un
 * message par défaut** de la bibliothèque, reconnu à sa forme anglaise.
 */

/** Les tournures que `class-validator` produit lui-même. */
const ANGLAIS =
  /(should not exist|must be|must not be|should not be|must contain|must match|must have|must equal|must exist|is not valid)/;

/**
 * Un message par contrainte, en français.
 *
 * La clé est le nom de la contrainte tel que `class-validator` le rend
 * dans `error.constraints` — `isString`, `isNotEmpty`, `whitelistValidation`…
 */
const MESSAGES: Record<string, (champ: string) => string> = {
  whitelistValidation: (champ) => `Le champ « ${champ} » n’est pas attendu ici.`,
  isNotEmpty: (champ) => `Le champ « ${champ} » est obligatoire.`,
  isDefined: (champ) => `Le champ « ${champ} » est obligatoire.`,
  isString: (champ) => `Le champ « ${champ} » doit être du texte.`,
  isNumber: (champ) => `Le champ « ${champ} » doit être un nombre.`,
  isInt: (champ) => `Le champ « ${champ} » doit être un nombre entier.`,
  isBoolean: (champ) => `Le champ « ${champ} » doit être vrai ou faux.`,
  isArray: (champ) => `Le champ « ${champ} » doit être une liste.`,
  arrayNotEmpty: (champ) => `Le champ « ${champ} » ne peut pas être vide.`,
  isEmail: () => 'Cette adresse e-mail n’est pas valide.',
  isUUID: (champ) => `L’identifiant « ${champ} » n’est pas valide.`,
  isDateString: (champ) => `La date « ${champ} » n’est pas valide.`,
  isEnum: (champ) => `La valeur de « ${champ} » n’est pas reconnue.`,
  isPositive: (champ) => `Le champ « ${champ} » doit être supérieur à zéro.`,
  isLatitude: () => 'La latitude n’est pas valide.',
  isLongitude: () => 'La longitude n’est pas valide.',
  isUrl: (champ) => `Le champ « ${champ} » doit être une adresse web.`,
  min: (champ) => `Le champ « ${champ} » est trop petit.`,
  max: (champ) => `Le champ « ${champ} » est trop grand.`,
  minLength: (champ) => `Le champ « ${champ} » est trop court.`,
  maxLength: (champ) => `Le champ « ${champ} » est trop long.`,
  matches: (champ) => `Le champ « ${champ} » n’a pas le format attendu.`,
};

/**
 * Traduit un message de validation, ou le laisse tel quel.
 *
 * @param contrainte Nom de la contrainte (`isString`, `whitelistValidation`…).
 * @param champ      Propriété concernée, telle que l'appelant l'a envoyée.
 * @param message    Ce que `class-validator` a produit.
 */
export function enFrancais(contrainte: string, champ: string, message: string): string {
  // Un message rédigé à la main dans le DTO : il est déjà en français et
  // dit mieux les choses.
  if (!ANGLAIS.test(message)) return message;

  const traduction = MESSAGES[contrainte];
  if (traduction) return traduction(champ);

  // Une contrainte qu'on n'a pas prévue : mieux vaut une phrase française
  // vague qu'une phrase anglaise précise, que personne ne lira ici.
  return `Le champ « ${champ} » n’est pas valide.`;
}
