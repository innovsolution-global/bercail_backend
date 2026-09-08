import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Impose le changement de mot de passe à la première connexion.
 *
 * Un livreur créé par un ADMIN, ou un ADMIN créé par le SUPER_ADMIN,
 * reçoit un mot de passe temporaire. Tant qu'il ne l'a pas changé, son
 * jeton n'ouvre que `/auth/me`, `/auth/change-password` et `/auth/logout`.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (request.user?.mustChangePassword) {
      throw AppException.forbidden(
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        'Vous devez définir un nouveau mot de passe avant de continuer.',
      );
    }

    return true;
  }
}
