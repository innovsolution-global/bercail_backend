import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restreint une route à un ou plusieurs rôles.
 *
 * Le rôle est la première barrière, jamais la seule : une route ADMIN
 * exige en plus la permission correspondante, et les routes portant sur
 * une ressource vérifient l'appartenance.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
