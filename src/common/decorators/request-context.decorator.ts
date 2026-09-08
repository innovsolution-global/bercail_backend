import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestContext } from '../types/authenticated-user';

/** Extrait l'IP réelle, y compris derrière un reverse proxy. */
export function extractIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip ?? request.socket?.remoteAddress ?? undefined;
}

/**
 * Contexte technique de la requête : identifiant de corrélation, IP et
 * user-agent. C'est ce qui est journalisé et audité — jamais le corps.
 */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): RequestContext => {
  const request = context.switchToHttp().getRequest<Request & { requestId?: string }>();
  return {
    requestId: request.requestId ?? 'unknown',
    ipAddress: extractIp(request),
    userAgent: request.headers['user-agent'],
  };
});
