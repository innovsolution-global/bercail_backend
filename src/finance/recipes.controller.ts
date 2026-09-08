import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { SaveRecipeDto } from './dto/recipe.dto';
import { RecipesService } from './recipes.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Fiches techniques.
 *
 * Montées sous `/menu/items/:id/recipe` : la fiche appartient au plat, pas
 * au stock. C'est en modifiant la carte qu'on décide ce qu'un plat
 * consomme, et le stock ne fait qu'en subir les conséquences.
 */
@ApiTags('Fiches techniques')
@Controller(['menu/items/:menuItemId/recipe', 'menu-items/:menuItemId/recipe'])
@Roles(...BACK_OFFICE)
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  @RequirePermissions('MENU_READ')
  @ApiEndpoint({
    summary: 'Fiche technique d’un plat',
    description:
      'Ingrédients et quantités par portion, coût de revient au coût moyen pondéré, et marge réelle.',
    roles: [...BACK_OFFICE],
    permissions: ['MENU_READ'],
  })
  find(@Param('menuItemId') menuItemId: string) {
    return this.recipes.findForMenuItem(menuItemId);
  }

  @Put()
  @RequirePermissions('MENU_UPDATE')
  @ApiEndpoint({
    summary: 'Enregistrer la fiche technique',
    description:
      'Remplace la fiche entière. Une liste vide efface la fiche : le plat cesse alors de mouvementer le stock à la préparation.',
    roles: [...BACK_OFFICE],
    permissions: ['MENU_UPDATE'],
  })
  save(
    @Param('menuItemId') menuItemId: string,
    @Body() dto: SaveRecipeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.recipes.save(menuItemId, dto, user, context);
  }
}
