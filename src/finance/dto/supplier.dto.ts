import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { STOCK_CATEGORIES_WIRE, STOCK_UNITS_WIRE } from './common.dto';

/**
 * Un article que le fournisseur livre.
 *
 * Il entre dans le stock de la maison, rattaché au fournisseur, pour
 * qu'un achat puisse le choisir. Le propriétaire écrivait ses articles
 * dans « Spécialité », un simple texte — et ne retrouvait rien à l'achat.
 */
export class SupplierItemDto {
  @ApiProperty({ example: 'Pomme' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: STOCK_CATEGORIES_WIRE, default: 'autre' })
  @IsOptional()
  @IsIn(STOCK_CATEGORIES_WIRE)
  category?: (typeof STOCK_CATEGORIES_WIRE)[number];

  @ApiPropertyOptional({ enum: STOCK_UNITS_WIRE, default: 'kg' })
  @IsOptional()
  @IsIn(STOCK_UNITS_WIRE)
  unit?: (typeof STOCK_UNITS_WIRE)[number];
}

export class CreateSupplierDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Volailles du Niger' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Mamadou Diallo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @ApiPropertyOptional({ example: '622334455' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(150)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({ example: 'Volailles et œufs' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  speciality?: string;

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

  /**
   * Les articles qu'il livre, à créer dans le stock avec le fournisseur.
   * À la modification, ce sont des articles **en plus** : ceux déjà en
   * stock se gèrent sur la page Stock.
   */
  @ApiPropertyOptional({ type: [SupplierItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SupplierItemDto)
  items?: SupplierItemDto[];
}

/** Tous les champs deviennent facultatifs : on corrige ce qu'on veut. */
export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

export class SupplierQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'inactive', 'all'] })
  @IsOptional()
  @IsIn(['active', 'inactive', 'all'])
  status?: 'active' | 'inactive' | 'all';
}
