import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  EXPENSE_CATEGORIES_WIRE,
  EXPENSE_STATUSES_WIRE,
  FINANCE_PAYMENT_METHODS_WIRE,
  FinanceListQueryDto,
  INCOME_CATEGORIES_WIRE,
} from './common.dto';

export class CreateExpenseDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Facture EDG — août' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  label!: string;

  @ApiProperty({ enum: EXPENSE_CATEGORIES_WIRE })
  @IsIn(EXPENSE_CATEGORIES_WIRE)
  category!: (typeof EXPENSE_CATEGORIES_WIRE)[number];

  @ApiProperty({ description: 'Montant en GNF.', example: 850000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({ enum: ['paid', 'pending'], default: 'paid' })
  @IsOptional()
  @IsIn(['paid', 'pending'])
  status?: 'paid' | 'pending';

  @ApiPropertyOptional({ enum: FINANCE_PAYMENT_METHODS_WIRE, default: 'cash' })
  @IsOptional()
  @IsIn(FINANCE_PAYMENT_METHODS_WIRE)
  paymentMethod?: (typeof FINANCE_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Date d’engagement de la charge, ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  incurredAt?: string;

  @ApiPropertyOptional({ description: 'Échéance de paiement, ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional({
    example: '2026-08',
    description: 'Mois couvert par la charge, au format AAAA-MM.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period doit être au format AAAA-MM.' })
  period?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Employé concerné, pour un salaire.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  invoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Charge qui revient chaque mois (loyer, abonnement).',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  isRecurring?: boolean;
}

export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {}

export class SettleExpenseDto {
  @ApiPropertyOptional({ enum: FINANCE_PAYMENT_METHODS_WIRE })
  @IsOptional()
  @IsIn(FINANCE_PAYMENT_METHODS_WIRE)
  paymentMethod?: (typeof FINANCE_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Date de règlement, ISO 8601. Par défaut : maintenant.' })
  @IsOptional()
  @IsISO8601()
  paidAt?: string;
}

export class ExpenseQueryDto extends FinanceListQueryDto {
  @ApiPropertyOptional({ enum: [...EXPENSE_CATEGORIES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: [...EXPENSE_STATUSES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ example: '2026-08' })
  @IsOptional()
  @IsString()
  period?: string;
}

export class CreateIncomeDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Location de la salle — baptême' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  label!: string;

  @ApiPropertyOptional({ enum: INCOME_CATEGORIES_WIRE, default: 'autre' })
  @IsOptional()
  @IsIn(INCOME_CATEGORIES_WIRE)
  category?: (typeof INCOME_CATEGORIES_WIRE)[number];

  @ApiProperty({ description: 'Montant en GNF.', example: 1500000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({ enum: FINANCE_PAYMENT_METHODS_WIRE, default: 'cash' })
  @IsOptional()
  @IsIn(FINANCE_PAYMENT_METHODS_WIRE)
  method?: (typeof FINANCE_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({ description: 'Date d’encaissement, ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateIncomeDto extends PartialType(CreateIncomeDto) {}

export class IncomeQueryDto extends FinanceListQueryDto {
  @ApiPropertyOptional({ enum: [...INCOME_CATEGORIES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  category?: string;
}
