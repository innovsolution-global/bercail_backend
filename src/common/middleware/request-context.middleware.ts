import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    startedAt?: number;
  }
}

/**
 * Identifiant de corrélation.
 *
 * Chaque requête reçoit un `x-request-id` (repris s'il vient déjà du
 * client ou d'un proxy). Il se retrouve dans les logs, dans les réponses
 * d'erreur et dans le journal d'audit : un incident se suit de bout en bout.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length <= 80 ? incoming : randomUUID();

    request.requestId = requestId;
    request.startedAt = Date.now();
    response.setHeader('x-request-id', requestId);

    next();
  }
}
