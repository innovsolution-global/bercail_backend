import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
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
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import {
  CONTRACT_TYPES_WIRE,
  EMPLOYEE_STATUSES_WIRE,
  FINANCE_PAYMENT_METHODS_WIRE,
} from './common.dto';

export class CreateEmployeeDto {
  @ApiPropertyOptional({
    description:
      'Établissement visé. Inutile pour un ADMIN — il écrit dans le sien ; obligatoire pour un SUPER_ADMIN, qui les voit tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({ example: 'Fatoumata' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  firstName!: string;

  @ApiProperty({ example: 'Camara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  lastName!: string;

  @ApiPropertyOptional({ example: '622112233' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(150)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiProperty({ example: 'Cuisinier' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  position!: string;

  @ApiPropertyOptional({ enum: CONTRACT_TYPES_WIRE, default: 'cdi' })
  @IsOptional()
  @IsIn(CONTRACT_TYPES_WIRE)
  contractType?: (typeof CONTRACT_TYPES_WIRE)[number];

  @ApiPropertyOptional({ enum: EMPLOYEE_STATUSES_WIRE, default: 'active' })
  @IsOptional()
  @IsIn(EMPLOYEE_STATUSES_WIRE)
  status?: (typeof EMPLOYEE_STATUSES_WIRE)[number];

  @ApiProperty({ description: 'Salaire mensuel en GNF.', example: 1500000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  baseSalary!: number;

  @ApiPropertyOptional({ description: 'Date d’embauche, ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  hiredAt?: string;

  @ApiPropertyOptional({ description: 'Date de fin de contrat, ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  endedAt?: string;

  @ApiPropertyOptional({ description: 'Compte du back-office associé, si l’employé en a un.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}

export class EmployeeQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: [...EMPLOYEE_STATUSES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: [...CONTRACT_TYPES_WIRE, 'all'] })
  @IsOptional()
  @IsString()
  contractType?: string;

  @ApiPropertyOptional({ description: 'Filtrer par poste occupé.' })
  @IsOptional()
  @IsString()
  position?: string;
}

/**
 * Génération de la paie d'un mois.
 *
 * L'opération est idempotente par construction : un employé qui a déjà
 * une ligne de salaire pour la période est ignoré, jamais payé deux fois.
 */
export class GeneratePayrollDto {
  @ApiProperty({ example: '2026-09', description: 'Mois à payer, au format AAAA-MM.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period doit être au format AAAA-MM.' })
  period!: string;

  @ApiPropertyOptional({
    description: 'Limiter à ces employés. Par défaut : tout l’effectif actif.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  employeeIds?: string[];

  @ApiPropertyOptional({ enum: FINANCE_PAYMENT_METHODS_WIRE, default: 'cash' })
  @IsOptional()
  @IsIn(FINANCE_PAYMENT_METHODS_WIRE)
  paymentMethod?: (typeof FINANCE_PAYMENT_METHODS_WIRE)[number];

  @ApiPropertyOptional({
    default: false,
    description: 'Marquer les salaires comme déjà réglés.',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  markPaid?: boolean;
}

export class PayrollQueryDto {
  @ApiPropertyOptional({ example: '2026-09' })
  @IsOptional()
  @IsString()
  period?: string;
}
