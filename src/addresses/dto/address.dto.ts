import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

  @ApiPropertyOptional({ example: 9.509167, description: 'Position GPS choisie sur la carte.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: -13.712222 })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
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
}
