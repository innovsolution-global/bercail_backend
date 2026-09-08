import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import {
  FinanceListQueryDto,
  STOCK_CATEGORIES_WIRE,
  STOCK_MOVEMENT_REASONS_WIRE,
  STOCK_MOVEMENT_TYPES_WIRE,
  STOCK_UNITS_WIRE,
} from './common.dto';

export class CreateStockItemDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Poulet entier' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'ING-POULET', description: 'Code interne, unique.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reference?: string;

  @ApiProperty({ enum: STOCK_CATEGORIES_WIRE, default: 'autre' })
  @IsIn(STOCK_CATEGORIES_WIRE)
  category!: (typeof STOCK_CATEGORIES_WIRE)[number];

  @ApiProperty({ enum: STOCK_UNITS_WIRE, default: 'kg' })
  @IsIn(STOCK_UNITS_WIRE)
  unit!: (typeof STOCK_UNITS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Stock de départ, dans l’unité de l’article.', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ description: 'Seuil d’alerte de réapprovisionnement.', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minQuantity?: number;

  @ApiPropertyOptional({ description: 'Coût unitaire connu, en GNF.', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  averageCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;
}

/**
 * La quantité n'est pas modifiable ici : elle ne bouge que par un
 * mouvement de stock, qui laisse une trace. Corriger un stock « à la main »
 * dans le formulaire de l'article rendrait le journal faux.
 */
export class UpdateStockItemDto extends PartialType(
  OmitType(CreateStockItemDto, ['quantity'] as const),
) {}

export class StockItemQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: [...STOCK_CATEGORIES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    enum: ['low', 'out', 'ok', 'all'],
    description: '`low` = sous le seuil d’alerte, `out` = épuisé.',
  })
  @IsOptional()
  @IsIn(['low', 'out', 'ok', 'all'])
  level?: 'low' | 'out' | 'ok' | 'all';

  @ApiPropertyOptional({ enum: ['active', 'inactive', 'all'] })
  @IsOptional()
  @IsIn(['active', 'inactive', 'all'])
  status?: 'active' | 'inactive' | 'all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supplierId?: string;
}

/**
 * Mouvement de stock saisi à la main : entrée hors achat, sortie de
 * cuisine, perte ou correction d'inventaire.
 */
export class CreateStockMovementDto {
  @ApiProperty()
  @IsUUID()
  stockItemId!: string;

  @ApiProperty({ enum: STOCK_MOVEMENT_TYPES_WIRE })
  @IsIn(STOCK_MOVEMENT_TYPES_WIRE)
  type!: (typeof STOCK_MOVEMENT_TYPES_WIRE)[number];

  @ApiPropertyOptional({ enum: STOCK_MOVEMENT_REASONS_WIRE, default: 'other' })
  @IsOptional()
  @IsIn(STOCK_MOVEMENT_REASONS_WIRE)
  reason?: (typeof STOCK_MOVEMENT_REASONS_WIRE)[number];

  @ApiProperty({
    description:
      'Quantité, toujours positive. Pour un ajustement, c’est le stock réellement compté.',
    example: 12.5,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Coût unitaire en GNF (entrées uniquement).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @ApiPropertyOptional({ description: 'Date du mouvement, ISO 8601. Par défaut : maintenant.' })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class StockMovementQueryDto extends FinanceListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stockItemId?: string;

  @ApiPropertyOptional({ enum: [...STOCK_MOVEMENT_TYPES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ enum: [...STOCK_MOVEMENT_REASONS_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  reason?: string;
}
