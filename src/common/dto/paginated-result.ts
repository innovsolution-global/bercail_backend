import { ApiProperty } from '@nestjs/swagger';

/**
 * Enveloppe de pagination.
 *
 * Elle est renvoyée telle quelle par l'intercepteur de réponse :
 * `{ success, data: [...], meta: { page, limit, total, totalPages } }`.
 */
export class PaginationMeta {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 137 })
  total!: number;

  @ApiProperty({ example: 7 })
  totalPages!: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

export function paginate<T>(data: T[], total: number, page: number, limit: number): PaginatedResult<T> {
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

/**
 * Construit une réponse paginée à partir d'un `findMany` + `count` déjà
 * exécutés en parallèle. Le mapper transforme chaque entité en DTO réseau.
 */
export function toPaginated<TEntity, TDto>(
  rows: TEntity[],
  total: number,
  page: number,
  limit: number,
  mapper: (entity: TEntity) => TDto,
): PaginatedResult<TDto> {
  return paginate(rows.map(mapper), total, page, limit);
}
