import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PHONE_PATTERN } from '../../auth/dto/auth.dto';

const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Domicile' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @ApiProperty({ example: 'Rue KA 021, Kaloum' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street!: string;

  @ApiPropertyOptional({ example: 'Kaloum' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @ApiPropertyOptional({ example: 'Conakry' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  /*
   * La position est **obligatoire** à la création.
   *
   * Elle était facultative, et une adresse sur cinq en base n'en avait
   * pas. Or c'est elle qui décide de tout : quelle maison sert le
   * client (la plus proche de chez lui), et où le livreur va — sans
   * point, il cherche « N'nakaké » dans une application de plans.
   * Décision du propriétaire, le 11 septembre 2026.
   */
  @ApiProperty({ example: 9.509167, description: 'Position GPS de l’adresse. Obligatoire.' })
  @IsDefined({ message: 'La position GPS de l’adresse est obligatoire.' })
  @Type(() => Number)
  @IsLatitude({ message: 'La latitude n’est pas valide.' })
  latitude!: number;

  @ApiProperty({ example: -13.712222 })
  @IsDefined({ message: 'La position GPS de l’adresse est obligatoire.' })
  @Type(() => Number)
  @IsLongitude({ message: 'La longitude n’est pas valide.' })
  longitude!: number;

  @ApiPropertyOptional({ description: 'Numéro à appeler à la livraison.' })
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  phone?: string;

  @ApiPropertyOptional({ example: 'Portail bleu, sonner deux fois.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  instructions?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  isDefault?: boolean;
}

export class UpdateAddressDto extends CreateAddressDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  declare street: string;

  // Une modification partielle n'a pas à renvoyer la position : elle
  // reste ce qu'elle était. Seule la création l'exige.
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude({ message: 'La latitude n’est pas valide.' })
  declare latitude: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude({ message: 'La longitude n’est pas valide.' })
  declare longitude: number;
}
