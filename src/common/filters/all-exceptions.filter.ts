import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';

/**
 * Filtre d'exception unique.
 *
 * Il produit un corps d'erreur stable pour les deux frontends :
 *
 * ```json
 * {
 *   "success": false,
 *   "statusCode": 403,
 *   "code": "FORBIDDEN",
 *   "message": "Vous n'avez pas les permissions nécessaires.",
 *   "errors": { "email": "..." },
 *   "error": { "code": "FORBIDDEN", "message": "..." }
 * }
 * ```
 *
 * `message`/`code`/`errors` sont ce que lit l'intercepteur Axios du
 * back-office ; `error` est la forme imposée par le contrat d'API.
 * Une erreur 500 n'expose jamais la trace technique.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  private readonly statusCodes: Record<number, string> = {
    400: ERROR_CODES.BAD_REQUEST,
    401: ERROR_CODES.UNAUTHORIZED,
    403: ERROR_CODES.FORBIDDEN,
    404: ERROR_CODES.NOT_FOUND,
    409: ERROR_CODES.CONFLICT,
    422: ERROR_CODES.VALIDATION_ERROR,
    429: ERROR_CODES.RATE_LIMITED,
  };

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request & { requestId?: string; user?: { id: string } }>();

    const resolved = this.resolve(exception);

    if (resolved.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.originalUrl} → ${resolved.status} ${resolved.code} [req:${request.requestId ?? '-'}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(
        `${request.method} ${request.originalUrl} → ${resolved.status} ${resolved.code} [req:${request.requestId ?? '-'}]`,
      );
    }

    response.status(resolved.status).json({
      success: false,
      statusCode: resolved.status,
      code: resolved.code,
      message: resolved.message,
      ...(resolved.fieldErrors ? { errors: resolved.fieldErrors } : {}),
      error: {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.details ? { details: resolved.details } : {}),
      },
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
    });
  }

  private resolve(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    fieldErrors?: Record<string, string>;
  } {
    if (exception instanceof AppException) {
      const body = exception.getResponse() as { code: string; message: string; details?: unknown };
      return {
        status: exception.getStatus(),
        code: body.code,
        message: body.message,
        details: body.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        return { status, code: this.statusCodes[status] ?? ERROR_CODES.SERVER_ERROR, message: body };
      }

      const payload = body as {
        message?: string | string[];
        code?: string;
        error?: string;
        errors?: Record<string, string>;
      };

      // ValidationPipe renvoie un tableau de messages : on le transforme en
      // erreurs champ par champ, exploitables directement par un formulaire.
      const messages = Array.isArray(payload.message) ? payload.message : undefined;
      const fieldErrors = messages ? this.toFieldErrors(messages) : payload.errors;

      return {
        status,
        code: payload.code ?? this.statusCodes[status] ?? ERROR_CODES.SERVER_ERROR,
        message:
          (Array.isArray(payload.message) ? payload.message[0] : payload.message) ??
          payload.error ??
          'Une erreur est survenue.',
        fieldErrors,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.BAD_REQUEST,
        message: 'La requête est invalide.',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.SERVER_ERROR,
      message: 'Une erreur interne est survenue. Réessayez dans un instant.',
    };
  }

  private resolvePrisma(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: string;
    message: string;
    fieldErrors?: Record<string, string>;
  } {
    switch (exception.code) {
      case 'P2002': {
        const target = (exception.meta?.target as string[] | undefined) ?? [];
        const field = target[0] ?? 'valeur';
        return {
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CONFLICT,
          message: `Cette ${this.humanize(field)} est déjà utilisée.`,
          fieldErrors: { [field]: 'Déjà utilisé.' },
        };
      }
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.NOT_FOUND,
          message: 'Cette ressource est introuvable.',
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CONFLICT,
          message: 'Cette opération référence une ressource inexistante.',
        };
      case 'P2034':
        return {
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CONFLICT,
          message: 'Opération concurrente détectée. Réessayez.',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ERROR_CODES.SERVER_ERROR,
          message: 'Une erreur interne est survenue. Réessayez dans un instant.',
        };
    }
  }

  private humanize(field: string): string {
    const labels: Record<string, string> = {
      email: 'adresse e-mail',
      phone: 'numéro de téléphone',
      code: 'valeur',
      slug: 'valeur',
      reference: 'référence',
      driverCode: 'code livreur',
    };
    return labels[field] ?? 'valeur';
  }

  /** « email must be an email » → `{ email: 'email must be an email' }`. */
  private toFieldErrors(messages: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const message of messages) {
      const field = message.split(' ')[0];
      if (field && !result[field]) result[field] = message;
    }
    return result;
  }
}
