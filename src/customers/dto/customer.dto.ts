import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PHONE_PATTERN } from '../../auth/dto/auth.dto';

// Le profil personnel se modifie via `UpdateProfileDto` (module auth) :
// la même route sert les quatre rôles.
export { UpdateProfileDto } from '../../auth/dto/auth.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'active', 'inactive', 'suspended', 'all'] })
  @IsOptional()
  @IsString()
  status?: string;
}

/** Correction d'une fiche client par le back-office. */
export class UpdateCustomerDto {
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
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email?: string;
}
