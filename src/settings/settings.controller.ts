import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, Public, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { UpdateRestaurantSettingsDto, UpdateSystemSettingsDto } from './dto/settings.dto';
import { SettingsService } from './settings.service';

/**
 * Paramètres.
 *
 * `/settings/restaurant` : ADMIN avec la permission adéquate.
 * `/settings/system`     : SUPER_ADMIN uniquement (sécurité, maintenance).
 */
@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('restaurant')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_READ')
  @ApiEndpoint({
    summary: 'Paramètres du restaurant',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['SETTINGS_READ'],
  })
  async getRestaurant() {
    const restaurant = await this.settings.getRestaurant();
    return this.settings.toRestaurantSettingsDto(restaurant);
  }

  @Patch('restaurant')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_UPDATE')
  @ApiEndpoint({
    summary: 'Modifier les paramètres du restaurant',
    description: 'Horaires, frais de livraison, minimum de commande, zones desservies. Action auditée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['SETTINGS_UPDATE'],
  })
  updateRestaurant(
    @Body() dto: UpdateRestaurantSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.settings.updateRestaurant(dto, user, context);
  }

  @Get('system')
  @Roles(Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_SYSTEM')
  @ApiEndpoint({
    summary: 'Paramètres système',
    roles: [Role.SUPER_ADMIN],
    permissions: ['SETTINGS_SYSTEM'],
  })
  async getSystem() {
    const settings = await this.settings.getSystemSettings();
    return this.settings.toSystemSettingsDto(settings);
  }

  @Patch('system')
  @Roles(Role.SUPER_ADMIN)
  @RequirePermissions('SETTINGS_SYSTEM')
  @ApiEndpoint({
    summary: 'Modifier les paramètres système',
    description:
      'Maintenance, politique de mot de passe, rétention des journaux, intégrations. Réservé au SUPER_ADMIN et intégralement audité.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['SETTINGS_SYSTEM'],
  })
  updateSystem(
    @Body() dto: UpdateSystemSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.settings.updateSystemSettings(dto, user, context);
  }
}

/**
 * Fiche publique du restaurant.
 *
 * Consommée par l'application Flutter avant même toute connexion :
 * horaires, frais de livraison, minimum de commande, état d'ouverture.
 */
@ApiTags('Restaurant')
@Controller('restaurant')
export class RestaurantController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Public()
  @ApiEndpoint({
    summary: 'Fiche du restaurant',
    description:
      "Informations publiques, y compris `isOpenNow` calculé côté serveur : l'application n'a pas à déduire l'ouverture des horaires.",
    public: true,
  })
  get() {
    return this.settings.getPublicRestaurant();
  }
}
