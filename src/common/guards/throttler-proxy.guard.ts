import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Request } from 'express';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Limitation de débit derrière un proxy.
 *
 * Deux corrections par rapport au guard par défaut :
 *  - la clé est l'utilisateur authentifié quand il y en a un (sinon des
 *    clients partageant une IP mobile se bloquent mutuellement) ;
 *  - l'erreur 429 emprunte le format d'erreur de l'API.
 */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  /**
   * Échappatoire réservée aux suites de tests, qui enchaînent
   * volontairement les connexions et se bloqueraient elles-mêmes.
   *
   * Elle n'est jamais honorée en production : même avec la variable
   * positionnée, la limitation reste active.
   */
  private readonly disabled =
    process.env.NODE_ENV !== 'production' && process.env.THROTTLE_DISABLED === 'true';

  protected override async shouldSkip(): Promise<boolean> {
    return this.disabled;
  }

  protected override async getTracker(request: Request & { user?: AuthenticatedUser }): Promise<string> {
    if (request.user?.id) return `user:${request.user.id}`;

    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return `ip:${forwarded.split(',')[0].trim()}`;
    }
    return `ip:${request.ip ?? request.socket?.remoteAddress ?? 'unknown'}`;
  }

  protected override async throwThrottlingException(
    _context: unknown,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw AppException.tooManyRequests(
      ERROR_CODES.RATE_LIMITED,
      'Trop de tentatives. Réessayez dans quelques instants.',
    );
  }
}
