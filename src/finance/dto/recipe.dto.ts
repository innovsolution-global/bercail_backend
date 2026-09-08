import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Un ingrédient de la fiche, pour **une** portion. */
export class RecipeIngredientDto {
  @ApiProperty({ description: 'Article de stock consommé.' })
  @IsUUID()
  stockItemId!: string;

  @ApiProperty({
    description: 'Quantité pour une portion, dans l’unité de l’article.',
    example: 0.4,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional({ example: 'Cuisse uniquement' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/**
 * Fiche technique complète d'un plat.
 *
 * L'enregistrement est intégral : la liste envoyée devient la fiche. Une
 * liste vide efface la fiche — le plat cesse alors de mouvementer le stock.
 */
export class SaveRecipeDto {
  @ApiProperty({ type: [RecipeIngredientDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientDto)
  ingredients!: RecipeIngredientDto[];
}
