import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { VILLES, VILLE_INCONNUE } from '../../geo/referentiel';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class OpeningHourDto {
  @ApiProperty({ minimum: 1, maximum: 7, description: '1 = lundi … 7 = dimanche (ISO-8601).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;

  @ApiProperty({ example: '10:00' })
  @Matches(TIME_PATTERN, { message: 'opensAt doit être au format HH:mm.' })
  opensAt!: string;

  @ApiProperty({ example: '23:00' })
  @Matches(TIME_PATTERN, { message: 'closesAt doit être au format HH:mm.' })
  closesAt!: string;

  @ApiProperty({ default: false })
  @IsBoolean()
  isClosed!: boolean;
}

/**
 * Paramètres du restaurant.
 *
 * Tous les champs sont optionnels : le back-office envoie un correctif
 * partiel. Les montants restent des entiers en GNF.
 */
export class UpdateRestaurantSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tagline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  /** Conakry, ou l'une des préfectures de Guinée — voir [[REGIONS]]. */
  @ApiPropertyOptional({ enum: VILLES })
  @IsOptional()
  @IsString()
  @IsIn(VILLES, { message: VILLE_INCONNUE })
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ type: [OpeningHourDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpeningHourDto)
  openingHours?: OpeningHourDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  deliveryEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pickupEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Frais de livraison en GNF (entier).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFee?: number;

  @ApiPropertyOptional({ description: 'Seuil de livraison offerte en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  freeDeliveryThreshold?: number;

  @ApiPropertyOptional({ description: 'Minimum de commande en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minimumOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  averagePreparationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  averageDeliveryMinutes?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deliveryZones?: string[];
}

class NotificationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  newOrderSound?: boolean;
}

class IntegrationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  orangeMoneyEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  mtnMoneyEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cardPaymentEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['osm', 'google', 'none'] })
  @IsOptional()
  @IsIn(['osm', 'google', 'none'])
  mapsProvider?: string;
}

/** Paramètres système — SUPER_ADMIN uniquement. */
export class UpdateSystemSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  maintenanceMessage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(10_080)
  sessionTimeoutMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(8)
  @Max(64)
  passwordMinLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireTwoFactor?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(20)
  maxLoginAttempts?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3650)
  auditRetentionDays?: number;

  @ApiPropertyOptional({ type: NotificationSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationSettingsDto)
  notifications?: NotificationSettingsDto;

  @ApiPropertyOptional({ type: IntegrationSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => IntegrationSettingsDto)
  integrations?: IntegrationSettingsDto;
}
