import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRestaurantDto {
  @ApiProperty({
    example: 'BRC2',
    description:
      'Code court, unique. Il identifie l’établissement dans l’interface et distingue ses références de commande de celles des autres.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{2,12}$/, {
    message: 'Le code doit contenir 2 à 12 caractères alphanumériques.',
  })
  code!: string;

  @ApiProperty({ example: 'Le Bercail — Kipé' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tagline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(600)
  description?: string;

  @ApiProperty({ example: '+224620000002' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;

  @ApiProperty({ example: 'kipe@lebercail.gn' })
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  email!: string;

  @ApiProperty({ example: 'Kipé, carrefour Constantin' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  address!: string;

  @ApiPropertyOptional({ example: 'Ratoma' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @ApiPropertyOptional({ example: 'Conakry' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiProperty({ example: 9.6412 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: -13.6215 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ description: 'Frais de livraison en GNF.', default: 15000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFee?: number;

  @ApiPropertyOptional({ description: 'Commande minimum en GNF.', default: 50000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minimumOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isOpen?: boolean;
}

/** Tous les champs deviennent facultatifs, plus l'activité de l'adresse. */
export class UpdateRestaurantDto extends PartialType(CreateRestaurantDto) {
  @ApiPropertyOptional({ description: 'Une adresse inactive n’accepte plus de commande.' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;
}
