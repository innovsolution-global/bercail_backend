import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const DELIVERY_STATUSES_WIRE = [
  'assigned',
  'accepted',
  'arrived_at_restaurant',
  'picked_up',
  'in_transit',
  'arrived_at_customer',
  'delivered',
  'failed',
] as const;

export class DeliveryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: [...DELIVERY_STATUSES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filtrer par livreur (profil livreur).' })
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;
}

export class DriverDeliveryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['active', 'history', 'all'],
    description: '`active` = courses en cours, `history` = terminées.',
  })
  @IsOptional()
  @IsIn(['active', 'history', 'all'])
  scope?: 'active' | 'history' | 'all';
}

/** Correction de statut par le back-office (incident, litige). */
export class UpdateDeliveryStatusDto {
  @ApiProperty({ enum: DELIVERY_STATUSES_WIRE })
  @IsIn(DELIVERY_STATUSES_WIRE)
  status!: (typeof DELIVERY_STATUSES_WIRE)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  comment?: string;
}

export class DeclineDeliveryDto {
  @ApiProperty({ description: 'Motif du refus (tracé et notifié au back-office).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

export class FailDeliveryDto {
  @ApiProperty({ description: "Motif de l'échec (client injoignable, adresse introuvable…)." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

/**
 * Validation de la remise : le livreur marque la course livrée.
 *
 * Sans code : le propriétaire veut un geste simple. Seule la position au
 * moment de la remise est acceptée, pour la trace.
 */
export class CompleteDeliveryDto {
  @ApiPropertyOptional({ description: 'Position au moment de la remise.' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}

/**
 * Position du livreur.
 *
 * Envoyée régulièrement pendant une course. Le serveur horodate lui-même :
 * un appareil dont l'horloge est fausse ne doit pas fausser le suivi.
 */
export class UpdateLocationDto {
  @ApiProperty({ example: 9.535 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: -13.6785 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ description: 'Précision GPS en mètres.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10_000)
  accuracy?: number;

  @ApiPropertyOptional({ description: 'Cap en degrés (0-360).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number;

  @ApiPropertyOptional({ description: 'Vitesse en m/s.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  speed?: number;

  @ApiPropertyOptional({ description: 'Course concernée, si le livreur est en mission.' })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}

export class UpdateDriverAvailabilityDto {
  @ApiPropertyOptional({ description: 'En service ou non.' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isOnline?: boolean;

  @ApiPropertyOptional({ description: 'Prêt à recevoir une course.' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isAvailable?: boolean;
}

export class AssignableDriversQueryDto {
  @ApiPropertyOptional({ description: 'Commande à livrer : sert à calculer les distances.' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  zone?: string;
}
