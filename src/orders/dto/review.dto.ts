import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** La note d'un plat de la commande. */
export class ReviewItemDto {
  @ApiProperty({ description: 'La ligne de commande notée.' })
  @IsUUID()
  orderItemId!: string;

  @ApiProperty({ example: 4, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1, { message: 'Une note va de 1 à 5.' })
  @Max(5, { message: 'Une note va de 1 à 5.' })
  rating!: number;
}

/**
 * L'avis d'un client sur une commande livrée.
 *
 * La note de la maison est la seule obligatoire : c'est la question
 * qu'on pose d'abord. Le livreur ne se note que s'il y en a eu un, et
 * les plats un par un, seulement ceux qu'on veut noter.
 */
export class CreateReviewDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 5, description: 'La note du restaurant.' })
  @IsInt()
  @Min(1, { message: 'Une note va de 1 à 5.' })
  @Max(5, { message: 'Une note va de 1 à 5.' })
  restaurantRating!: number;

  @ApiPropertyOptional({ example: 4, minimum: 1, maximum: 5, description: 'La note du livreur.' })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Une note va de 1 à 5.' })
  @Max(5, { message: 'Une note va de 1 à 5.' })
  driverRating?: number;

  @ApiPropertyOptional({ example: 'Livraison rapide, plat encore chaud.' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Le commentaire ne peut pas dépasser 500 caractères.' })
  comment?: string;

  @ApiPropertyOptional({ type: [ReviewItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReviewItemDto)
  items?: ReviewItemDto[];
}
