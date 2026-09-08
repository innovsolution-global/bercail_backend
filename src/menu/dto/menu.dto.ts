import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

/* ───────────────────────────── Catégories ─────────────────────────────── */

export class CreateCategoryDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Grillades' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: '🔥' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isActive?: boolean;
}

export class UpdateCategoryDto extends CreateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  declare name: string;
}

export class CategoryQueryDto {
  @ApiPropertyOptional({ description: 'Inclure les catégories désactivées (back-office).' })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  includeInactive?: boolean;
}

/* ─────────────────────────── Options produits ─────────────────────────── */

export class MenuOptionInputDto {
  @ApiPropertyOptional({ description: 'Présent lors d’une mise à jour.' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Frites maison' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'Supplément en GNF ; 0 = inclus.', example: 5000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  extraPrice!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isAvailable?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class MenuOptionGroupInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Accompagnement' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isRequired?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  minSelect?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxSelect?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiProperty({ type: [MenuOptionInputDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => MenuOptionInputDto)
  options!: MenuOptionInputDto[];
}

/* ───────────────────────────── Produits ───────────────────────────────── */

export class CreateMenuItemDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'Poulet braisé' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Mariné 12 h, sauce maison' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  shortDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Prix en GNF (entier).', example: 75000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({ description: 'Prix promotionnel en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  promoPrice?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ingredients?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isAvailable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isPopular?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isSuggestion?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isSpicy?: boolean;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  preparationMinutes?: number;

  @ApiPropertyOptional({ type: [MenuOptionGroupInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MenuOptionGroupInputDto)
  optionGroups?: MenuOptionGroupInputDto[];
}

export class UpdateMenuItemDto extends CreateMenuItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  declare categoryId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  declare name: string;

  @ApiPropertyOptional({ description: 'Prix en GNF (entier).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  declare price: number;
}

export class UpdateAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  @Transform(toBoolean)
  isAvailable!: boolean;
}

export class MenuItemQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filtrer par catégorie (id ou slug).' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ['available', 'unavailable', 'all'] })
  @IsOptional()
  @IsIn(['available', 'unavailable', 'all'])
  availability?: 'available' | 'unavailable' | 'all';

  @ApiPropertyOptional({ description: 'Uniquement les produits populaires.' })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  popular?: boolean;

  @ApiPropertyOptional({ description: 'Uniquement les suggestions du chef.' })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  suggestion?: boolean;

  @ApiPropertyOptional({ description: 'Prix minimum en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Prix maximum en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;
}
