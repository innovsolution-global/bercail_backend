import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Ajout au panier.
 *
 * Aucun prix n'est accepté : le client envoie ce qu'il veut manger,
 * le serveur décide de ce que cela coûte.
 */
export class AddCartItemDto {
  @ApiProperty()
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ minimum: 1, maximum: 50, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number;

  @ApiPropertyOptional({ type: [String], description: 'Identifiants des options choisies.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  optionIds?: string[];

  @ApiPropertyOptional({ example: 'Sans piment' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class UpdateCartItemDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 50, description: '0 retire la ligne.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  quantity?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  optionIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class CartQueryDto {
  @ApiPropertyOptional({ enum: ['delivery', 'pickup'], default: 'delivery' })
  @IsOptional()
  @IsIn(['delivery', 'pickup'])
  orderType?: 'delivery' | 'pickup';

  @ApiPropertyOptional({ description: 'Code promotionnel à simuler.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  promotionCode?: string;
}
