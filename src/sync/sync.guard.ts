import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

/**
 * Authentification entre serveurs.
 *
 * La synchronisation n'agit au nom d'aucun utilisateur : elle ne présente
 * donc pas de jeton JWT mais un secret partagé entre les deux nœuds. Un
 * secret vide ferme la porte — mieux vaut une synchronisation qui ne
 * démarre pas qu'une route ouverte sur la base entière.
 */
@Injectable()
export class SyncGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('sync.secret') ?? '';

    if (!this.config.get<boolean>('sync.enabled') || expected.length === 0) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'La synchronisation est désactivée sur ce serveur.',
      );
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const provided = request.headers['x-sync-secret'] ?? '';

    if (!this.matches(provided, expected)) {
      throw AppException.unauthorized(ERROR_CODES.UNAUTHORIZED, 'Secret de synchronisation invalide.');
    }

    return true;
  }

  /**
   * Comparaison à durée constante.
   *
   * Une comparaison ordinaire s'arrête au premier caractère différent, ce
   * qui laisse deviner le secret octet par octet.
   */
  private matches(provided: string, expected: string): boolean {
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
