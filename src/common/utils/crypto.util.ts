import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Primitives cryptographiques partagées.
 *
 * Aucun secret n'est stocké en clair : les refresh tokens, jetons
 * d'activation et codes OTP ne vivent en base que sous forme de
 * condensat SHA-256.
 */

/** Condensat stable, utilisé pour indexer un jeton sans le stocker. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Jeton opaque à usage unique (activation, réinitialisation, refresh). */
export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/** Identifiant de famille de rotation pour les refresh tokens. */
export function randomFamily(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Code numérique (OTP de livraison, mot de passe temporaire).
 * `randomInt` s'appuie sur le générateur cryptographique, pas sur Math.random.
 */
export function randomNumericCode(length: number): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

/** Mot de passe temporaire lisible, remis à un livreur ou un admin. */
export function randomPassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%&*';
  let password = '';
  for (let index = 0; index < length - 2; index += 1) {
    password += alphabet[randomInt(0, alphabet.length)];
  }
  // Au moins un chiffre et un symbole : les politiques de mot de passe
  // du backend s'appliquent aussi aux mots de passe qu'il génère.
  password += randomInt(0, 10).toString();
  password += symbols[randomInt(0, symbols.length)];
  return password;
}

/**
 * Comparaison à temps constant.
 * Utilisée partout où une différence de durée révélerait un secret
 * (vérification d'OTP, de jeton d'activation).
 */
export function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** Empreinte d'un corps de requête, pour l'idempotence. */
export function hashPayload(payload: unknown): string {
  return sha256(JSON.stringify(payload ?? {}));
}
