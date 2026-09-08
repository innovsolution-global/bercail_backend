import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Deuxième barrière : le rôle.
 *
 * Le rôle vient du jeton **et** est revalidé depuis la base à chaque
 * requête : un compte rétrogradé perd ses accès immédiatement, sans
 * attendre l'expiration de son access token.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw AppException.unauthorized(ERROR_CODES.UNAUTHORIZED, 'Authentification requise.');
    }

    if (!required.includes(user.role)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Vous n'avez pas les permissions nécessaires.",
      );
    }

    return true;
  }
}
