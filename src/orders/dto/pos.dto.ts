import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderLineDto } from './order.dto';

/** Une vente au comptoir se consomme sur place ou s'emporte. */
export const POS_ORDER_TYPES_WIRE = ['dine_in', 'pickup'] as const;

/**
 * Règlements acceptés à la caisse. `cash_on_delivery` désigne ici
 * simplement les espèces : c'est la valeur que connaît déjà le reste de
 * l'application, on ne crée pas un doublon pour la caisse.
 */
export const POS_PAYMENT_METHODS_WIRE = [
  'cash_on_delivery',
  'orange_money',
  'mtn_money',
  'mobile_money',
  'card',
] as const;

/**
 * Vente au comptoir.
 *
 * Comme pour une commande de l'application, aucun montant n'est accepté du
 * client : la caisse envoie des plats et des quantités, le serveur calcule.
 * Seule exception assumée : la remise commerciale, qui est une décision
 * humaine — elle est donc plafonnée au sous-total et tracée.
 */
export class CreatePosOrderDto {
  @ApiProperty({ enum: POS_ORDER_TYPES_WIRE, default: 'dine_in' })
  @IsIn(POS_ORDER_TYPES_WIRE)
  type!: (typeof POS_ORDER_TYPES_WIRE)[number];

  @ApiProperty({ type: [OrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items!: OrderLineDto[];

  @ApiProperty({ enum: POS_PAYMENT_METHODS_WIRE, default: 'cash_on_delivery' })
  @IsIn(POS_PAYMENT_METHODS_WIRE)
  paymentMethod!: (typeof POS_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Nom donné au comptoir, pour appeler le client.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  customerPhone?: string;

  @ApiPropertyOptional({ description: 'Numéro de table, pour un service en salle.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  @ApiPropertyOptional({ description: 'Remise accordée en GNF. Plafonnée au sous-total.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  discount?: number;

  @ApiPropertyOptional({ description: 'Somme remise par le client, en GNF.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountReceived?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Vrai (défaut) : la commande est servie et encaissée immédiatement. Faux : elle part en cuisine et suivra le cycle normal.',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  servedImmediately?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'Faux pour une note à régler plus tard (ardoise).',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  paid?: boolean;

  @ApiPropertyOptional({ description: 'Consigne pour la cuisine.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Aperçu du ticket avant encaissement. */
export class QuotePosOrderDto {
  @ApiProperty({ enum: POS_ORDER_TYPES_WIRE, default: 'dine_in' })
  @IsIn(POS_ORDER_TYPES_WIRE)
  type!: (typeof POS_ORDER_TYPES_WIRE)[number];

  @ApiProperty({ type: [OrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items!: OrderLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  discount?: number;
}
