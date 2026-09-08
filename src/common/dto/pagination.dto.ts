import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Paramètres communs à toutes les listes.
 *
 * Aucune collection n'est jamais renvoyée en entier : la pagination est
 * imposée côté serveur, y compris si le client ne demande rien.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page demandée (1-indexée).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 100,
    description: 'Taille de page. Plafonnée à 100 par le serveur.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;

  @ApiPropertyOptional({ description: 'Recherche plein texte (selon la ressource).' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ description: 'Champ de tri.' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortOrder: 'asc' | 'desc' = 'desc';

  get skip(): number {
    return (this.page - 1) * this.limit;
  }

  get take(): number {
    return this.limit;
  }
}

/** Filtre de période, partagé par les rapports, l'audit et les listes. */
export class DateRangeQueryDto {
  @ApiPropertyOptional({ description: 'Début de période, ISO 8601 (inclus).' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fin de période, ISO 8601 (incluse).' })
  @IsOptional()
  @IsString()
  to?: string;
}
