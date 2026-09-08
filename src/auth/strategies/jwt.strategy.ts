import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { AccountStatus, Role } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppException, ERROR_CODES } from '../../common/exceptions/app.exception';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../database/prisma.service';
import { PermissionsService } from '../../rbac/permissions.service';
import type { AccessTokenPayload } from '../token.service';

/**
 * Reconstruction de l'utilisateur à partir du jeton.
 *
 * Le JWT ne sert qu'à identifier : le rôle, le statut et les permissions
 * sont relus depuis la base à chaque requête. Un compte suspendu perd
 * l'accès immédiatement, sans attendre l'expiration de son access token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret')!,
      issuer: config.get<string>('jwt.issuer'),
      audience: config.get<string>('jwt.audience'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'access') {
      throw AppException.unauthorized(ERROR_CODES.INVALID_TOKEN, 'Jeton invalide.');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        mustChangePassword: true,
        restaurantId: true,
        driverProfile: { select: { id: true } },
      },
    });

    if (!user) {
      throw AppException.unauthorized(ERROR_CODES.UNAUTHORIZED, 'Compte introuvable.');
    }

    if (user.status === AccountStatus.SUSPENDED) {
      throw AppException.forbidden(
        ERROR_CODES.ACCOUNT_SUSPENDED,
        'Votre compte est suspendu. Contactez le restaurant.',
      );
    }

    if (user.status === AccountStatus.INACTIVE) {
      throw AppException.forbidden(ERROR_CODES.ACCOUNT_INACTIVE, 'Votre compte est désactivé.');
    }

    if (user.status === AccountStatus.PENDING) {
      throw AppException.forbidden(
        ERROR_CODES.ACCOUNT_PENDING,
        "Votre compte n'est pas encore activé.",
      );
    }

    const permissions = await this.permissions.getEffectivePermissions(user.id, user.role);

    // Trace d'activité, utilisée par le tableau de bord SUPER_ADMIN.
    // Volontairement sans await : elle ne doit jamais ralentir la requête.
    void this.prisma.user
      .update({ where: { id: user.id }, data: { lastActivityAt: new Date() } })
      .catch(() => undefined);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role as Role,
      status: user.status,
      permissions,
      restaurantId: user.restaurantId ?? null,
      driverProfileId: user.driverProfile?.id ?? null,
      mustChangePassword: user.mustChangePassword,
      sessionId: payload.sid,
    };
  }
}
