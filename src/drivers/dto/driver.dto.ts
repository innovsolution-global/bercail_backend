import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  IsUUID,
} from 'class-validator';
import { PHONE_PATTERN } from '../../auth/dto/auth.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const VEHICLE_TYPES_WIRE = ['moto', 'scooter', 'velo', 'voiture'] as const;
export const ACCOUNT_STATUSES_WIRE = ['pending', 'active', 'inactive', 'suspended'] as const;

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Création d'un livreur.
 *
 * Aucun mot de passe n'est demandé : le backend en génère un temporaire
 * (ou un lien d'activation). Un gestionnaire ne choisit jamais le mot de
 * passe de quelqu'un d'autre.
 */
export class CreateDriverDto {
  @ApiPropertyOptional({
    description:
      'Établissement de rattachement. Inutile pour un ADMIN — le compte rejoint le sien ; obligatoire pour un SUPER_ADMIN, qui les gère tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Ibrahima' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  firstName!: string;

  @ApiProperty({ example: 'Camara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  lastName!: string;

  @ApiProperty({ example: 'ibrahima.camara@lebercail.gn' })
  @IsEmail()
  @Transform(normalizeEmail)
  email!: string;

  @ApiProperty({ example: '+224620334455' })
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  phone!: string;

  @ApiPropertyOptional({ enum: VEHICLE_TYPES_WIRE, default: 'moto' })
  @IsOptional()
  @IsIn(VEHICLE_TYPES_WIRE)
  vehicleType?: (typeof VEHICLE_TYPES_WIRE)[number];

  @ApiPropertyOptional({ example: 'RC-2451-A' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  plateNumber?: string;

  @ApiPropertyOptional({ example: 'Kaloum' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  zone?: string;

  @ApiPropertyOptional({
    enum: ['temporary_password', 'activation_link'],
    default: 'temporary_password',
    description:
      "`temporary_password` : le back-office remet le mot de passe au livreur, qui doit le changer à sa première connexion. `activation_link` : le livreur choisit lui-même son mot de passe.",
  })
  @IsOptional()
  @IsIn(['temporary_password', 'activation_link'])
  credentialMode?: 'temporary_password' | 'activation_link';

  @ApiPropertyOptional({
    minLength: 8,
    description:
      "Mot de passe initial. Omis en mode `temporary_password`, le serveur en engendre un. Ignoré en mode `activation_link`.",
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password?: string;
}

export class UpdateDriverDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  phone?: string;

  @ApiPropertyOptional({ enum: VEHICLE_TYPES_WIRE })
  @IsOptional()
  @IsIn(VEHICLE_TYPES_WIRE)
  vehicleType?: (typeof VEHICLE_TYPES_WIRE)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  plateNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  zone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class UpdateAccountStatusDto {
  @ApiProperty({ enum: ACCOUNT_STATUSES_WIRE })
  @IsIn(ACCOUNT_STATUSES_WIRE)
  status!: (typeof ACCOUNT_STATUSES_WIRE)[number];

  @ApiPropertyOptional({ description: 'Motif — obligatoire pour une suspension.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class DriverQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: [...ACCOUNT_STATUSES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: ['online', 'offline', 'all'] })
  @IsOptional()
  @IsString()
  availability?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  zone?: string;
}
