import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PHONE_PATTERN } from '../../auth/dto/auth.dto';
import { VILLES, VILLE_INCONNUE } from '../../geo/referentiel';

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

  /**
   * La ville : Conakry, ou l'une des préfectures de Guinée.
   *
   * Prise dans le référentiel ([[REGIONS]]) et non tapée : une ville
   * écrite librement ne se retrouve ni dans un filtre ni dans un rapport.
   * Le quartier reste libre — à Conakry, l'application propose les
   * communes ; ailleurs, il n'y a pas de liste.
   */
  @ApiPropertyOptional({ example: 'Conakry', enum: VILLES })
  @IsOptional()
  @IsString()
  @IsIn(VILLES, { message: VILLE_INCONNUE })
  city?: string;

  /*
   * La position de l'adresse est **facultative**.
   *
   * Elle a été obligatoire du 11 au 15 septembre 2026. Le propriétaire
   * est revenu dessus : un client enregistre son adresse au bureau et
   * commande le soir de chez lui, à l'autre bout de la ville — la
   * position qui compte est celle où il **est** au moment de commander.
   * Elle est donc relevée à la commande ([[CreateOrderDto]]), et c'est
   * elle qui désigne la maison la plus proche et guide le livreur. Celle
   * de l'adresse ne sert plus que de repli pour choisir la carte servie
   * quand le téléphone ne se situe pas.
   */
  @ApiPropertyOptional({
    example: 9.509167,
    description:
      'Position GPS de l’adresse, facultative : la position de livraison est relevée à la commande.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude({ message: 'La latitude n’est pas valide.' })
  latitude?: number;

  @ApiPropertyOptional({ example: -13.712222 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude({ message: 'La longitude n’est pas valide.' })
  longitude?: number;

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
