import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type {
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { Role } from '@prisma/client';
import type { Permission } from '../constants/permissions.constant';

export interface ApiEndpointOptions {
  summary: string;
  description?: string;
  roles?: Role[];
  permissions?: Permission[];
  /** Route ouverte (ni jeton, ni rôle). */
  public?: boolean;
  /** DTO renvoyé dans `data`. */
  type?: Type<unknown>;
  isArray?: boolean;
  paginated?: boolean;
}

/**
 * Documente un endpoint de façon homogène.
 *
 * Chaque route de l'API annonce, dans Swagger, son rôle et sa permission :
 * le contrat d'autorisation est lisible sans ouvrir le code (cf. §89).
 */
export function ApiEndpoint(options: ApiEndpointOptions) {
  const parts: string[] = [];
  if (options.description) parts.push(options.description);
  parts.push(options.public ? '**Authentification :** aucune.' : '**Authentification :** Bearer JWT.');
  if (options.roles?.length) parts.push(`**Rôles :** ${options.roles.join(', ')}.`);
  if (options.permissions?.length) parts.push(`**Permissions :** ${options.permissions.join(', ')}.`);

  const decorators: (ClassDecorator | MethodDecorator | PropertyDecorator)[] = [
    ApiOperation({ summary: options.summary, description: parts.join('\n\n') }),
  ];

  if (!options.public) {
    decorators.push(
      ApiBearerAuth(),
      ApiUnauthorizedResponse({ description: 'Jeton absent, expiré ou invalide.' }),
      ApiForbiddenResponse({ description: 'Rôle ou permission insuffisants.' }),
    );
  }

  decorators.push(ApiTooManyRequestsResponse({ description: 'Trop de requêtes.' }));

  if (options.type) {
    const dataSchema: SchemaObject | ReferenceObject = options.isArray
      ? { type: 'array', items: { $ref: getSchemaPath(options.type) } }
      : { $ref: getSchemaPath(options.type) };

    const properties: Record<string, SchemaObject | ReferenceObject> = {
      success: { type: 'boolean', example: true },
      data: dataSchema,
    };

    if (options.paginated) {
      properties.meta = {
        type: 'object',
        properties: {
          page: { type: 'number', example: 1 },
          limit: { type: 'number', example: 20 },
          total: { type: 'number', example: 137 },
          totalPages: { type: 'number', example: 7 },
        },
      };
    }

    decorators.push(ApiOkResponse({ schema: { type: 'object', properties } }));
  }

  return applyDecorators(...(decorators as MethodDecorator[]));
}
