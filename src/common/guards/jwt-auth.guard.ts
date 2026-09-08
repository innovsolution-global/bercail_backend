import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import { IS_PUBLIC_KEY, OPTIONAL_AUTH_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Première barrière : l'authentification.
 *
 * Le guard est monté globalement. Une route n'est accessible sans jeton
 * que si elle le déclare — l'oubli d'un décorateur ferme l'accès, il ne
 * l'ouvre jamais.
 *
 * Trois régimes :
 *  - normal : jeton obligatoire ;
 *  - `@Public()` : aucun jeton n'est lu ;
 *  - `@OptionalAuth()` : le jeton est lu s'il est présent et valide, sinon
 *    la requête continue en anonyme.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  private isOptional(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  override handleRequest<TUser = AuthenticatedUser>(
    error: unknown,
    user: TUser,
    info: { name?: string; message?: string } | undefined,
    context: ExecutionContext,
  ): TUser {
    if (error || !user) {
      // Authentification facultative : on continue sans utilisateur.
      if (this.isOptional(context)) return undefined as TUser;

      if (info?.name === 'TokenExpiredError') {
        throw AppException.unauthorized(
          ERROR_CODES.TOKEN_EXPIRED,
          'Votre session a expiré. Veuillez vous reconnecter.',
        );
      }
      if (error instanceof AppException) throw error;
      throw AppException.unauthorized(ERROR_CODES.UNAUTHORIZED, 'Authentification requise.');
    }
    return user;
  }
}
