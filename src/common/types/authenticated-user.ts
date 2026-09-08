import { Role } from '@prisma/client';
import type { Permission } from '../constants/permissions.constant';

/**
 * Utilisateur authentifié tel qu'il circule dans l'application.
 *
 * C'est le seul objet auquel les services font confiance : il est
 * reconstruit à chaque requête à partir du JWT **et** de la base, jamais
 * à partir d'un en-tête ou d'un champ envoyé par Flutter ou React.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  status: string;
  firstName: string;
  lastName: string;
  /** Permissions effectives : socle du rôle ± ajustements individuels. */
  permissions: Permission[];
  /**
   * Établissement du compte.
   *
   * Nul pour un CUSTOMER — il commande où il veut — et pour le SUPER_ADMIN,
   * qui les voit tous. C'est ce rattachement qui borne ce qu'un ADMIN ou un
   * DRIVER peut lire.
   */
  restaurantId?: string | null;
  /** Renseigné uniquement pour un DRIVER. */
  driverProfileId?: string | null;
  mustChangePassword: boolean;
  /** Identifiant de session (jti du refresh token courant). */
  sessionId?: string;
}

export interface RequestContext {
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
}
