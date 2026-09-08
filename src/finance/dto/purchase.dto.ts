import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  EXPENSE_STATUSES_WIRE,
  FINANCE_PAYMENT_METHODS_WIRE,
  FinanceListQueryDto,
  STOCK_UNITS_WIRE,
} from './common.dto';

/**
 * Ligne d'approvisionnement.
 *
 * Deux façons de saisir : `stockItemId` pour un article déjà connu, ou
 * `name` + `unit` pour un achat ponctuel qui n'entre pas au stock (un sac
 * de charbon acheté une fois). Le prix, lui, est toujours celui du jour.
 */
export class PurchaseLineDto {
  @ApiPropertyOptional({ description: 'Article de stock à mouvementer.' })
  @IsOptional()
  @IsUUID()
  stockItemId?: string;

  @ApiPropertyOptional({ description: 'Libellé libre, si l’article n’est pas au catalogue.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: STOCK_UNITS_WIRE, default: 'kg' })
  @IsOptional()
  @IsIn(STOCK_UNITS_WIRE)
  unit?: (typeof STOCK_UNITS_WIRE)[number];

  @ApiProperty({ example: 12.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiProperty({ description: 'Prix unitaire en GNF.', example: 45000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitPrice!: number;
}

export class CreatePurchaseDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Date de l’achat, ISO 8601. Par défaut : maintenant.' })
  @IsOptional()
  @IsISO8601()
  purchasedAt?: string;

  @ApiPropertyOptional({ enum: FINANCE_PAYMENT_METHODS_WIRE, default: 'cash' })
  @IsOptional()
  @IsIn(FINANCE_PAYMENT_METHODS_WIRE)
  paymentMethod?: (typeof FINANCE_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({
    enum: ['paid', 'pending'],
    default: 'paid',
    description: '`pending` = achat à crédit, réglé plus tard.',
  })
  @IsOptional()
  @IsIn(['paid', 'pending'])
  status?: 'paid' | 'pending';

  @ApiPropertyOptional({ description: 'Numéro de facture du fournisseur.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  invoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({ type: [PurchaseLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  items!: PurchaseLineDto[];
}

export class PurchaseQueryDto extends FinanceListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supplierId?: string;

  @ApiPropertyOptional({ enum: [...EXPENSE_STATUSES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  status?: string;
}

export class SettlePurchaseDto {
  @ApiPropertyOptional({ enum: FINANCE_PAYMENT_METHODS_WIRE })
  @IsOptional()
  @IsIn(FINANCE_PAYMENT_METHODS_WIRE)
  paymentMethod?: (typeof FINANCE_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Date de règlement, ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  paidAt?: string;
}

export class CancelPurchaseDto {
  @ApiProperty({ description: 'Motif d’annulation, tracé dans l’audit.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}
