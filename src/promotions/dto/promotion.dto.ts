import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  IsUUID,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const PROMOTION_TYPES_WIRE = ['percentage', 'fixed', 'free_delivery'] as const;

export class CreatePromotionDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Bienvenue au Bercail' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Visuel de la carte promotionnelle, téléversé via POST /storage/promotion.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiProperty({ example: 'BERCAIL10', description: 'Normalisé en majuscules.' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,30}$/, {
    message: 'code doit contenir 3 à 30 caractères alphanumériques.',
  })
  code!: string;

  @ApiProperty({ enum: PROMOTION_TYPES_WIRE })
  @IsIn(PROMOTION_TYPES_WIRE)
  type!: (typeof PROMOTION_TYPES_WIRE)[number];

  @ApiProperty({
    description: 'Pourcentage (1-100) ou montant fixe en GNF selon le type.',
    example: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  value!: number;

  @ApiPropertyOptional({ description: 'Minimum de commande en GNF.', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minimumOrder?: number;

  @ApiPropertyOptional({ description: 'Plafond de remise en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDiscount?: number;

  @ApiPropertyOptional({ description: 'Nombre total d’utilisations autorisées.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @ApiPropertyOptional({ description: 'Utilisations autorisées par client.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perCustomerLimit?: number;

  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ example: '2026-12-31T23:59:59.000Z' })
  @IsISO8601()
  endsAt!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;
}

export class UpdatePromotionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Visuel de la carte promotionnelle, téléversé via POST /storage/promotion.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{3,30}$/)
  code?: string;

  @ApiPropertyOptional({ enum: PROMOTION_TYPES_WIRE })
  @IsOptional()
  @IsIn(PROMOTION_TYPES_WIRE)
  type?: (typeof PROMOTION_TYPES_WIRE)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minimumOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDiscount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perCustomerLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;
}

export class SetPromotionActiveDto {
  @ApiProperty()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive!: boolean;
}

export class PromotionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'inactive', 'all'] })
  @IsOptional()
  @IsIn(['active', 'inactive', 'all'])
  isActive?: 'active' | 'inactive' | 'all';
}
