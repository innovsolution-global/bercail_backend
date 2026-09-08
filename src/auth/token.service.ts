import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AlertSeverity, Role, User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { randomFamily, sha256 } from '../common/utils/crypto.util';
import type { RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Durée de vie de l'access token, en secondes. */
  expiresIn: number;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  type: 'access';
  sid?: string;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string;
  family: string;
  type: 'refresh';
}

/**
 * Émission, rotation et révocation des jetons.
 *
 * Access token court (15 min par défaut) + refresh token long, tournant
 * à chaque usage. Le refresh est signé **et** stocké en base sous forme
 * de condensat : il peut donc être révoqué immédiatement, ce qu'un JWT
 * seul ne permet pas.
 *
 * Rejeu détecté : si un refresh déjà consommé se représente, toute la
 * famille est révoquée et une alerte de sécurité est levée. C'est le
 * scénario du jeton volé.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get accessSecret(): string {
    return this.config.get<string>('jwt.accessSecret')!;
  }

  private get refreshSecret(): string {
    return this.config.get<string>('jwt.refreshSecret')!;
  }

  private get accessTtlSeconds(): number {
    return this.config.get<number>('jwt.accessTtlSeconds') ?? 900;
  }

  private get refreshTtlSeconds(): number {
    return this.config.get<number>('jwt.refreshTtlSeconds') ?? 60 * 60 * 24 * 30;
  }

  /** Première paire de jetons : ouvre une nouvelle famille de rotation. */
  async issuePair(user: User, context?: RequestContext): Promise<TokenPair> {
    return this.issue(user, randomFamily(), context);
  }

  private async issue(user: User, family: string, context?: RequestContext): Promise<TokenPair> {
    const jti = randomUUID();

    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
      sid: jti,
    };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
      issuer: this.config.get<string>('jwt.issuer'),
      audience: this.config.get<string>('jwt.audience'),
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      jti,
      family,
      type: 'refresh',
    };

    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshTtlSeconds,
      issuer: this.config.get<string>('jwt.issuer'),
      audience: this.config.get<string>('jwt.audience'),
    });

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        family,
        userAgent: context?.userAgent?.slice(0, 250),
        ipAddress: context?.ipAddress,
        expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
      },
    });

    return { accessToken, refreshToken, expiresIn: this.accessTtlSeconds };
  }

  /**
   * Rotation : le jeton présenté est révoqué et remplacé.
   * Renvoie l'utilisateur pour que l'appelant revalide son statut.
   */
  async rotate(rawRefreshToken: string, context?: RequestContext): Promise<{ user: User; tokens: TokenPair }> {
    let payload: RefreshTokenPayload;

    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(rawRefreshToken, {
        secret: this.refreshSecret,
        issuer: this.config.get<string>('jwt.issuer'),
        audience: this.config.get<string>('jwt.audience'),
      });
    } catch {
      throw AppException.unauthorized(
        ERROR_CODES.INVALID_TOKEN,
        'Session invalide. Veuillez vous reconnecter.',
      );
    }

    if (payload.type !== 'refresh') {
      throw AppException.unauthorized(ERROR_CODES.INVALID_TOKEN, 'Jeton de rafraîchissement invalide.');
    }

    const tokenHash = sha256(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw AppException.unauthorized(
        ERROR_CODES.INVALID_TOKEN,
        'Session invalide. Veuillez vous reconnecter.',
      );
    }

    if (stored.revokedAt) {
      // Un jeton déjà consommé qui revient : quelqu'un rejoue une copie.
      await this.revokeFamily(stored.family);
      await this.raiseReuseAlert(stored.userId, context);
      throw AppException.unauthorized(
        ERROR_CODES.REFRESH_TOKEN_REUSED,
        'Session compromise : toutes les sessions ont été fermées. Reconnectez-vous.',
      );
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw AppException.unauthorized(
        ERROR_CODES.TOKEN_EXPIRED,
        'Votre session a expiré. Veuillez vous reconnecter.',
      );
    }

    const tokens = await this.issue(stored.user, stored.family, context);

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: sha256(tokens.refreshToken) },
    });

    return { user: stored.user, tokens };
  }

  /** Ferme la session portée par ce refresh token (déconnexion simple). */
  async revokeByToken(rawRefreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(rawRefreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(family: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Déconnecte partout : suspension de compte, changement de mot de passe. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async listSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw AppException.notFound('Session introuvable.');
    }
  }

  /** Purge des jetons expirés (tâche planifiée). */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
    });
    return result.count;
  }

  private async raiseReuseAlert(userId: string, context?: RequestContext): Promise<void> {
    this.logger.warn(`Rejeu de refresh token détecté pour l'utilisateur ${userId}.`);
    await this.prisma.securityAlert.create({
      data: {
        severity: AlertSeverity.HIGH,
        title: 'Rejeu de jeton de session',
        description:
          "Un jeton de rafraîchissement déjà consommé a été présenté. Toutes les sessions de l'utilisateur ont été fermées.",
        metadata: {
          userId,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        },
      },
    });
  }
}
