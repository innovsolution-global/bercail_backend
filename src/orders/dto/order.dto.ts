import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { DateRangeQueryDto, PaginationQueryDto } from '../../common/dto/pagination.dto';

export const ORDER_TYPES_WIRE = ['delivery', 'pickup', 'dine_in'] as const;
export const PAYMENT_METHODS_WIRE = [
  'cash_on_delivery',
  'orange_money',
  'mtn_money',
  'mobile_money',
  'card',
] as const;
export const ORDER_STATUSES_WIRE = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'assigned',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;

export class OrderLineDto {
  @ApiProperty()
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  optionIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/**
 * Création de commande.
 *
 * Remarquez ce que ce DTO **ne contient pas** : ni `subtotal`, ni
 * `deliveryFee`, ni `discount`, ni `total`. Les montants ne sont pas
 * seulement ignorés côté serveur, ils sont refusés par le contrat.
 */
export class CreateOrderDto {
  @ApiProperty({ enum: ORDER_TYPES_WIRE, default: 'delivery' })
  @IsIn(ORDER_TYPES_WIRE)
  type!: (typeof ORDER_TYPES_WIRE)[number];

  @ApiPropertyOptional({ description: 'Obligatoire pour une livraison.' })
  @IsOptional()
  @IsUUID()
  addressId?: string;

  @ApiProperty({ enum: PAYMENT_METHODS_WIRE })
  @IsIn(PAYMENT_METHODS_WIRE)
  paymentMethod!: (typeof PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Code promotionnel à appliquer.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  promotionCode?: string;

  @ApiPropertyOptional({ description: 'Consigne pour la cuisine.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    type: [OrderLineDto],
    description:
      'Commande directe, sans passer par le panier. Si absent, le panier du client est utilisé.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items?: OrderLineDto[];
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: ORDER_STATUSES_WIRE })
  @IsIn(ORDER_STATUSES_WIRE)
  status!: (typeof ORDER_STATUSES_WIRE)[number];

  @ApiPropertyOptional({ description: 'Commentaire joint à l’historique.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  comment?: string;
}

export class CancelOrderDto {
  @ApiProperty({ description: 'Motif d’annulation (obligatoire, tracé dans l’audit).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

export class AssignDriverDto {
  @ApiProperty({ description: 'Identifiant du profil livreur.' })
  @IsUUID()
  driverId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  comment?: string;
}

export class OrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: [...ORDER_STATUSES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: ['pending', 'processing', 'paid', 'failed', 'refunded', 'all'] })
  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @ApiPropertyOptional({ enum: [...ORDER_TYPES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    enum: ['online', 'pos', 'all'],
    description: '`online` = application mobile, `pos` = vente au comptoir.',
  })
  @IsOptional()
  @IsString()
  channel?: string;

  @ApiPropertyOptional({ description: 'Filtrer par livreur (profil livreur).' })
  @IsOptional()
  @IsString()
  driverId?: string;

  @ApiPropertyOptional({ description: 'Filtrer par client.' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Début de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fin de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  to?: string;
}

export class CustomerOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['active', 'past', 'all'],
    description: '`active` = commandes en cours, `past` = livrées ou annulées.',
  })
  @IsOptional()
  @IsIn(['active', 'past', 'all'])
  scope?: 'active' | 'past' | 'all';
}

export class QuoteOrderDto {
  @ApiProperty({ enum: ORDER_TYPES_WIRE, default: 'delivery' })
  @IsIn(ORDER_TYPES_WIRE)
  type!: (typeof ORDER_TYPES_WIRE)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  promotionCode?: string;

  @ApiPropertyOptional({ type: [OrderLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items?: OrderLineDto[];
}

export { DateRangeQueryDto };
