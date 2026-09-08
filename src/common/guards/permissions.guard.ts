import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { Permission } from '../constants/permissions.constant';
import {
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
  type PermissionsMode,
} from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Troisième barrière : la permission.
 *
 * Les permissions effectives sont calculées côté serveur (socle du rôle
 * ± ajustements individuels) et attachées à la requête par la stratégie
 * JWT. Ce que Flutter ou React croient posséder n'a aucune valeur ici.
 *
 * Le SUPER_ADMIN passe toujours : il possède l'intégralité du catalogue.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw AppException.unauthorized(ERROR_CODES.UNAUTHORIZED, 'Authentification requise.');
    }

    if (user.role === Role.SUPER_ADMIN) return true;

    const mode =
      this.reflector.getAllAndOverride<PermissionsMode>(PERMISSIONS_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'all';

    const granted = new Set(user.permissions);
    const satisfied =
      mode === 'any'
        ? required.some((permission) => granted.has(permission))
        : required.every((permission) => granted.has(permission));

    if (!satisfied) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Vous n'avez pas les permissions nécessaires.",
        { required, mode },
      );
    }

    return true;
  }
}
