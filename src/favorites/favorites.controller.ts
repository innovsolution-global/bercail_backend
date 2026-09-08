import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, CurrentUser, Roles } from '../common/decorators';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { FavoritesService } from './favorites.service';

@ApiTags('Customers')
@Controller('favorites')
@Roles(Role.CUSTOMER)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @ApiEndpoint({ summary: 'Mes plats favoris', roles: [Role.CUSTOMER] })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.favorites.list(user.id);
  }

  @Get('ids')
  @ApiEndpoint({
    summary: 'Identifiants de mes favoris',
    description: 'Réponse légère, pour colorer les cœurs sur la carte sans recharger les plats.',
    roles: [Role.CUSTOMER],
  })
  ids(@CurrentUser() user: AuthenticatedUser) {
    return this.favorites.ids(user.id);
  }

  @Post(':menuItemId')
  @ApiEndpoint({ summary: 'Ajouter un favori', roles: [Role.CUSTOMER] })
  add(@CurrentUser() user: AuthenticatedUser, @Param('menuItemId') menuItemId: string) {
    return this.favorites.add(user.id, menuItemId);
  }

  @Delete(':menuItemId')
  @ApiEndpoint({ summary: 'Retirer un favori', roles: [Role.CUSTOMER] })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('menuItemId') menuItemId: string) {
    return this.favorites.remove(user.id, menuItemId);
  }
}
