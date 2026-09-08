import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Création d'un administrateur — réservée au SUPER_ADMIN.
 *
 * Deux façons de remettre les accès, comme pour un livreur :
 *   - `temporary_password` : le compte est utilisable immédiatement avec un
 *     mot de passe que le SUPER_ADMIN choisit ou que le serveur engendre. Il
 *     n'est renvoyé qu'une fois, à la création.
 *   - `activation_link` : le compte reste PENDING et l'intéressé choisit
 *     lui-même son mot de passe.
 *
 * Le rôle n'est pas un champ : cette route ne crée que des ADMIN, jamais un
 * second SUPER_ADMIN.
 */
export class CreateAdminDto {
  @ApiPropertyOptional({
    description:
      'Établissement de rattachement. Inutile pour un ADMIN — le compte rejoint le sien ; obligatoire pour un SUPER_ADMIN, qui les gère tous.',
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  lastName!: string;

  @ApiProperty()
  @IsEmail()
  @Transform(normalizeEmail)
  email!: string;

  @ApiProperty()
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  phone!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Permissions accordées. À défaut, le socle du rôle ADMIN s’applique. Les permissions réservées au SUPER_ADMIN sont refusées.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({
    enum: ['temporary_password', 'activation_link'],
    default: 'temporary_password',
    description:
      "`temporary_password` : le compte est actif tout de suite, avec un mot de passe remis en main propre. `activation_link` : le compte reste PENDING jusqu'à ce que l'intéressé choisisse son mot de passe.",
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

export class UpdateAdminDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class UpdateAdminPermissionsDto {
  @ApiProperty({ type: [String], description: 'Liste complète des permissions souhaitées.' })
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  permissions!: string[];
}

export class AdminQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ADMIN', 'SUPER_ADMIN', 'all'] })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ enum: ['pending', 'active', 'inactive', 'suspended', 'all'] })
  @IsOptional()
  @IsString()
  status?: string;
}

export class AdminStatusDto {
  @ApiProperty({ enum: ['pending', 'active', 'inactive', 'suspended'] })
  @IsIn(['pending', 'active', 'inactive', 'suspended'])
  status!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
