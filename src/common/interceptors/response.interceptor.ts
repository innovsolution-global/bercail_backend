import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { PaginationMeta } from '../dto/paginated-result';

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
  message?: string;
}

interface MaybePaginated {
  data: unknown;
  meta: PaginationMeta;
}

function isPaginated(value: unknown): value is MaybePaginated {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'meta' in value &&
    Array.isArray((value as MaybePaginated).data)
  );
}

/**
 * Enveloppe unique des réponses.
 *
 * `{ success: true, data }` pour une ressource,
 * `{ success: true, data: [...], meta }` pour une liste paginée.
 * Les téléchargements (exports) traversent sans être enveloppés.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T> | T> {
    return next.handle().pipe(
      map((payload) => {
        if (payload instanceof StreamableFile || Buffer.isBuffer(payload)) {
          return payload;
        }

        if (isPaginated(payload)) {
          return {
            success: true as const,
            data: payload.data as T,
            meta: payload.meta,
          };
        }

        return { success: true as const, data: payload ?? (null as T) };
      }),
    );
  }
}
