import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PHONE_PATTERN } from '../../auth/dto/auth.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class PaymentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'processing', 'paid', 'failed', 'refunded', 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    enum: ['cash_on_delivery', 'orange_money', 'mtn_money', 'mobile_money', 'card', 'all'],
  })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;
}

/**
 * Déclenchement d'un paiement mobile.
 *
 * Aucun montant : il est relu sur la commande. Le numéro sert uniquement
 * à adresser la demande à l'opérateur, et n'est stocké que tronqué.
 */
export class InitiatePaymentDto {
  @ApiPropertyOptional({ description: 'Numéro mobile money à débiter.' })
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  phone?: string;
}

export class ConfirmPaymentDto {
  @ApiPropertyOptional({ description: "Référence renvoyée par l'opérateur." })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  providerRef?: string;
}

export class FailPaymentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

export class RefundPaymentDto {
  @ApiProperty({ description: 'Motif du remboursement (obligatoire, tracé dans l’audit).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}
