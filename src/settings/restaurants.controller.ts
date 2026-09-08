import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant.dto';
import { RestaurantsService } from './restaurants.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Les établissements de l'enseigne.
 *
 * La liste sert d'abord au sélecteur du back-office : elle est donc
 * ouverte à tout compte d'exploitation, mais chacun n'y voit que ce qui le
 * concerne — un gérant, son adresse ; le propriétaire, toutes.
 *
 * Ouvrir ou fermer une adresse, en revanche, relève du seul propriétaire.
 */
@ApiTags('Établissements')
@Controller('restaurants')
@Roles(...BACK_OFFICE)
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}

  @Get()
  @ApiEndpoint({
    summary: 'Lister les établissements',
    description:
      'Un ADMIN n’y trouve que le sien ; le SUPER_ADMIN, tous. C’est cette liste qui alimente le sélecteur d’établissement.',
    roles: [...BACK_OFFICE],
  })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.restaurants.list(user);
  }

  @Get(':id')
  @ApiEndpoint({
    summary: 'Détail d’un établissement',
    roles: [...BACK_OFFICE],
  })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.restaurants.findOne(id, user);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_SYSTEM')
  @ApiEndpoint({
    summary: 'Ouvrir un établissement',
    description:
      'Réservé au propriétaire. Le nouvel établissement démarre vide : sa carte, son stock et son personnel sont à constituer.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['SETTINGS_SYSTEM'],
  })
  create(
    @Body() dto: CreateRestaurantDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.restaurants.create(dto, user, context);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_SYSTEM')
  @ApiEndpoint({
    summary: 'Modifier un établissement',
    roles: [Role.SUPER_ADMIN],
    permissions: ['SETTINGS_SYSTEM'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRestaurantDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.restaurants.update(id, dto, user, context);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_SYSTEM')
  @ApiEndpoint({
    summary: 'Fermer un établissement',
    description:
      'Suppression logique : le chiffre d’affaires et les dépenses de l’adresse restent dans les rapports d’exercice.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['SETTINGS_SYSTEM'],
  })
  close(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.restaurants.close(id, user, context);
  }
}
