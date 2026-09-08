import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * Vocabulaire réseau du module de gestion.
 *
 * Comme partout dans l'API, les énumérations circulent en lower_snake_case
 * et sont retraduites en UPPER_SNAKE_CASE avant d'atteindre la base.
 */

export const STOCK_UNITS_WIRE = [
  'kg',
  'g',
  'l',
  'ml',
  'piece',
  'sac',
  'carton',
  'bouteille',
  'plaque',
  'botte',
] as const;

export const STOCK_CATEGORIES_WIRE = [
  'viande',
  'poisson',
  'legume',
  'fruit',
  'epicerie',
  'boisson',
  'emballage',
  'entretien',
  'autre',
] as const;

export const STOCK_MOVEMENT_TYPES_WIRE = ['in', 'out', 'adjustment'] as const;

export const STOCK_MOVEMENT_REASONS_WIRE = [
  'purchase',
  'preparation',
  'waste',
  'inventory',
  'return',
  'other',
] as const;

export const EXPENSE_CATEGORIES_WIRE = [
  'ingredients',
  'boissons',
  'emballage',
  'electricite',
  'eau',
  'loyer',
  'salaire',
  'carburant',
  'transport',
  'maintenance',
  'equipement',
  'marketing',
  'taxes',
  'communication',
  'autre',
] as const;

export const EXPENSE_STATUSES_WIRE = ['pending', 'paid', 'cancelled'] as const;

export const INCOME_CATEGORIES_WIRE = [
  'location_salle',
  'evenement',
  'subvention',
  'remboursement',
  'apport',
  'autre',
] as const;

export const FINANCE_PAYMENT_METHODS_WIRE = [
  'cash',
  'orange_money',
  'mtn_money',
  'virement',
  'cheque',
  'carte',
  'autre',
] as const;

export const EMPLOYEE_STATUSES_WIRE = ['active', 'suspended', 'terminated'] as const;

export const CONTRACT_TYPES_WIRE = ['cdi', 'cdd', 'journalier', 'stage', 'prestataire'] as const;

export const ORDER_CHANNELS_WIRE = ['online', 'pos'] as const;

/** Filtre commun aux listes de gestion : période + pagination. */
export class FinanceListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Début de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fin de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  to?: string;
}

/** Sélection d'un mois civil, au format `AAAA-MM`. */
export class PeriodQueryDto {
  @ApiPropertyOptional({ example: '2026-09', description: 'Mois au format AAAA-MM.' })
  @IsOptional()
  @IsString()
  period?: string;
}

export class FinanceRangeQueryDto {
  @ApiPropertyOptional({ description: 'Début de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fin de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly', 'yearly'], default: 'daily' })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly', 'yearly'])
  granularity?: 'daily' | 'weekly' | 'monthly' | 'yearly';
}

/** Journal de caisse : période, sens du mouvement, pagination. */
export class LedgerQueryDto extends FinanceListQueryDto {
  @ApiPropertyOptional({
    enum: ['in', 'out', 'all'],
    description: '`in` = ce qui rentre, `out` = ce qui sort.',
  })
  @IsOptional()
  @IsIn(['in', 'out', 'all'])
  direction?: 'in' | 'out' | 'all';
}
