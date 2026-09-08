import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const OPTIONAL_AUTH_KEY = 'optionalAuth';

/**
 * Ouvre une route sans authentification.
 *
 * Le guard JWT est global : une route n'est publique que si elle le
 * déclare explicitement. L'oubli d'un décorateur ferme la route, il ne
 * l'ouvre jamais — c'est le sens sûr du défaut.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Route ouverte, mais qui reconnaît un porteur de jeton.
 *
 * La carte en est le bon exemple : tout le monde peut la consulter, mais
 * un ADMIN connecté doit voir aussi les plats en rupture. Un jeton absent
 * ou invalide n'est pas une erreur — la requête continue en anonyme.
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

export const ALLOW_PASSWORD_CHANGE_KEY = 'allowWhilePasswordChangeRequired';

/**
 * Autorise une route alors que l'utilisateur doit encore changer son mot
 * de passe (livreur ou admin à sa première connexion).
 */
export const AllowPasswordChangePending = () => SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);
