import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Normalise un e-mail : la casse ne doit jamais créer deux comptes. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Numéro guinéen ou international : `+224620000000` ou `620000000`. */
export const PHONE_PATTERN = /^\+?[0-9]{8,15}$/;

export class RegisterDto {
  @ApiProperty({ example: 'Mariama' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  firstName!: string;

  @ApiProperty({ example: 'Diallo' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  lastName!: string;

  @ApiProperty({ example: 'mariama.diallo@example.gn' })
  @IsEmail({}, { message: 'email doit être une adresse e-mail valide.' })
  @Transform(normalizeEmail)
  email!: string;

  @ApiProperty({ example: '+224620112233' })
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  @Transform(trim)
  phone!: string;

  @ApiProperty({ example: 'Bercail@2024', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'mariama.diallo@example.gn' })
  @IsString()
  @IsNotEmpty()
  @Transform(normalizeEmail)
  email!: string;

  @ApiProperty({ example: 'Bercail@2024' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({
    description: "Jeton d'appareil pour les notifications push (Flutter).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceToken?: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Refresh token à révoquer. Omis, seule la session courante est fermée.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'mariama.diallo@example.gn' })
  @IsString()
  @IsNotEmpty()
  @Transform(normalizeEmail)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Le code à six chiffres reçu par e-mail, ou le jeton du lien.' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  /**
   * L'adresse du compte, quand `token` est le code à six chiffres.
   *
   * Un code court ne vaut que pour le compte auquel il a été envoyé : sans
   * l'adresse, on ne saurait pas à qui le comparer. Le lien du back-office,
   * lui, porte un jeton long et se passe de l'adresse.
   */
  @ApiPropertyOptional({ example: 'mariama.diallo@example.gn' })
  @IsOptional()
  @IsString()
  @Transform(normalizeEmail)
  email?: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}

export class ActivateAccountDto {
  @ApiProperty({ description: "Jeton d'activation transmis par le back-office." })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

/**
 * Modification de son propre profil, par n'importe quel rôle.
 *
 * L'e-mail n'y figure pas : il sert d'identifiant de connexion et ne se
 * change pas par cette route. Le rôle et le statut non plus — un compte
 * ne s'auto-promeut pas.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Mariama' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Diallo' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  lastName?: string;

  @ApiPropertyOptional({ example: '+224620112233' })
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'phone doit être un numéro valide.' })
  @Transform(trim)
  phone?: string;

  @ApiPropertyOptional({ description: 'URL renvoyée par POST /storage/avatar.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;
}

export class RegisterDeviceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token!: string;

  @ApiPropertyOptional({ enum: ['android', 'ios', 'web'], default: 'android' })
  @IsOptional()
  @IsString()
  platform?: string;
}
