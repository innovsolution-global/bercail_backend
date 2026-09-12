import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiEndpoint,
  Ctx,
  CurrentUser,
  OptionalAuth,
  RequirePermissions,
  Roles,
} from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { CategoriesService } from './categories.service';
import {
  CategoryQueryDto,
  CreateCategoryDto,
  CreateMenuItemDto,
  MenuItemQueryDto,
  UpdateAvailabilityDto,
  UpdateCategoryDto,
  UpdateMenuItemDto,
} from './dto/menu.dto';
import { MenuItemsService } from './menu-items.service';

/**
 * Catégories.
 *
 * Deux chemins pour un seul contrôleur : `/categories` (contrat d'API) et
 * `/menu/categories` (chemin déjà consommé par le back-office React).
 * Une seule implémentation, donc aucune divergence possible.
 */
@ApiTags('Categories')
@Controller(['categories', 'menu/categories'])
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @OptionalAuth()
  @ApiEndpoint({
    summary: 'Lister les catégories',
    description:
      'Route publique : elle alimente l’accueil de l’application mobile. `includeInactive` n’est honoré que pour un compte du back-office.',
    public: true,
  })
  list(@Query() query: CategoryQueryDto, @CurrentUser() user?: AuthenticatedUser) {
    const isBackOffice = user?.role === Role.ADMIN || user?.role === Role.SUPER_ADMIN;
    return this.categories.list(Boolean(query.includeInactive) && isBackOffice, !isBackOffice);
  }

  @Get(':id')
  @OptionalAuth()
  @ApiEndpoint({ summary: 'Détail d’une catégorie (id ou slug)', public: true })
  findOne(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    const isBackOffice = user?.role === Role.ADMIN || user?.role === Role.SUPER_ADMIN;
    return this.categories.findOne(id, !isBackOffice);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('CATEGORIES_MANAGE')
  @ApiEndpoint({
    summary: 'Créer une catégorie',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CATEGORIES_MANAGE'],
  })
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.categories.create(dto, user, context);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('CATEGORIES_MANAGE')
  @ApiEndpoint({
    summary: 'Modifier une catégorie',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CATEGORIES_MANAGE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.categories.update(id, dto, user, context);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('CATEGORIES_MANAGE')
  @ApiEndpoint({
    summary: 'Supprimer une catégorie (logique)',
    description: 'Refusé tant que la catégorie contient des plats actifs.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CATEGORIES_MANAGE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.categories.remove(id, user, context);
  }
}

/**
 * Plats.
 *
 * `/menu-items` (contrat) et `/menu/items` (back-office) pointent vers le
 * même contrôleur.
 */
@ApiTags('Menu')
@Controller(['menu-items', 'menu/items'])
export class MenuItemsController {
  constructor(private readonly items: MenuItemsService) {}

  @Get()
  @OptionalAuth()
  @ApiEndpoint({
    summary: 'Lister les plats',
    description:
      'Sans jeton (ou pour un CUSTOMER/DRIVER), seuls les plats disponibles des catégories actives sont renvoyés. Un compte du back-office voit toute la carte.',
    public: true,
    paginated: true,
  })
  list(@Query() query: MenuItemQueryDto, @CurrentUser() user?: AuthenticatedUser) {
    const isBackOffice = user?.role === Role.ADMIN || user?.role === Role.SUPER_ADMIN;
    return this.items.list(query, { publicOnly: !isBackOffice });
  }

  @Get('highlights')
  @OptionalAuth()
  @ApiEndpoint({
    summary: 'Incontournables et suggestions',
    description: "Sélection éditoriale de l'accueil mobile, en une seule requête.",
    public: true,
  })
  highlights() {
    return this.items.highlights();
  }

  @Get(':id')
  @OptionalAuth()
  @ApiEndpoint({ summary: 'Détail d’un plat', public: true })
  findOne(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    const isBackOffice = user?.role === Role.ADMIN || user?.role === Role.SUPER_ADMIN;
    return this.items.findOne(id, { publicOnly: !isBackOffice });
  }

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('MENU_CREATE')
  @ApiEndpoint({
    summary: 'Créer un plat',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['MENU_CREATE'],
  })
  create(
    @Body() dto: CreateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.items.create(dto, user, context);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('MENU_UPDATE')
  @ApiEndpoint({
    summary: 'Modifier un plat',
    description: 'Un changement de prix est journalisé avec sa valeur avant/après.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['MENU_UPDATE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.items.update(id, dto, user, context);
  }

  @Patch(':id/availability')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('MENU_AVAILABILITY')
  @ApiEndpoint({
    summary: 'Marquer un plat disponible ou en rupture',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['MENU_AVAILABILITY'],
  })
  setAvailability(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.items.setAvailability(id, dto.isAvailable, user, context);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('MENU_DELETE')
  @ApiEndpoint({
    summary: 'Retirer un plat de la carte (logique)',
    description: 'Le plat sort aussi des paniers en cours.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['MENU_DELETE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.items.remove(id, user, context);
  }
}
