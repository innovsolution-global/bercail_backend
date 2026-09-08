import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Journal des requêtes.
 *
 * On journalise : requestId, userId, rôle, méthode, route, statut, durée.
 * On ne journalise JAMAIS : mot de passe, jeton, code OTP, secret de
 * paiement — d'où l'absence totale du corps de requête dans ces lignes.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string; user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.write(request, response.statusCode, startedAt),
        error: (error: { status?: number }) => this.write(request, error?.status ?? 500, startedAt),
      }),
    );
  }

  private write(
    request: Request & { requestId?: string; user?: AuthenticatedUser },
    status: number,
    startedAt: number,
  ): void {
    const duration = Date.now() - startedAt;
    const user = request.user;
    const actor = user ? `${user.id} ${user.role}` : 'anonyme';
    const line = `${request.method} ${request.originalUrl} ${status} ${duration}ms user=${actor} req=${request.requestId ?? '-'}`;

    if (status >= 500) this.logger.error(line);
    else if (status >= 400) this.logger.warn(line);
    else this.logger.log(line);
  }
}
