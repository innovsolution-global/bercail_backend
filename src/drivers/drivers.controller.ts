import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiEndpoint,
  Ctx,
  CurrentUser,
  RequirePermissions,
  Roles,
} from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { AssignableDriversQueryDto, UpdateDriverAvailabilityDto } from '../deliveries/dto/delivery.dto';
import { DriverAssignmentService } from '../deliveries/driver-assignment.service';
import { CreateDriverDto, DriverQueryDto, UpdateAccountStatusDto, UpdateDriverDto } from './dto/driver.dto';
import { DriversService } from './drivers.service';

/**
 * Gestion des livreurs — back-office.
 *
 * C'est le seul chemin de création d'un compte DRIVER : l'inscription
 * publique ne peut pas produire ce rôle.
 */
@ApiTags('Drivers')
@Controller('drivers')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly assignment: DriverAssignmentService,
  ) {}

  @Get()
  @RequirePermissions('DRIVERS_READ')
  @ApiEndpoint({
    summary: 'Lister les livreurs',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_READ'],
    paginated: true,
  })
  list(@Query() query: DriverQueryDto) {
    return this.drivers.list(query);
  }

  @Get('assignable')
  @RequirePermissions('DRIVERS_READ')
  @ApiEndpoint({
    summary: 'Livreurs disponibles pour une attribution',
    description:
      'Livreurs actifs, en ligne et disponibles, triés par charge puis par proximité si `orderId` est fourni.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_READ'],
  })
  assignable(@Query() query: AssignableDriversQueryDto) {
    return this.assignment.assignable({ orderId: query.orderId, zone: query.zone });
  }


  @Post()
  @RequirePermissions('DRIVERS_CREATE')
  @ApiEndpoint({
    summary: 'Créer un compte livreur',
    description:
      "Le backend génère un mot de passe temporaire (à changer à la première connexion) ou un lien d'activation. Les identifiants ne sont renvoyés qu'une seule fois, à la création.",
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_CREATE'],
  })
  create(
    @Body() dto: CreateDriverDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.drivers.create(dto, user, context);
  }

  @Get(':id')
  @RequirePermissions('DRIVERS_READ')
  @ApiEndpoint({
    summary: 'Fiche d’un livreur',
    description: 'Inclut ses statistiques et sa dernière position connue.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.drivers.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('DRIVERS_UPDATE')
  @ApiEndpoint({
    summary: 'Modifier un livreur',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_UPDATE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDriverDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.drivers.update(id, dto, user, context);
  }

  @Patch(':id/status')
  @RequirePermissions('DRIVERS_SUSPEND')
  @ApiEndpoint({
    summary: 'Suspendre ou réactiver un livreur',
    description:
      'Une suspension ferme toutes ses sessions. Impossible tant qu’il a des courses en cours. Action auditée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_SUSPEND'],
  })
  setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAccountStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.drivers.setStatus(id, dto, user, context);
  }

  @Post(':id/resend-activation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('DRIVERS_CREATE')
  @ApiEndpoint({
    summary: 'Renvoyer un lien d’activation',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DRIVERS_CREATE'],
  })
  resendActivation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.drivers.resendActivation(id, user, context);
  }

  @Delete(':id')
  @RequirePermissions('DRIVERS_DELETE')
  @ApiEndpoint({
    summary: 'Supprimer un livreur (logique)',
    description: 'Les courses passées restent consultables. Réservé au SUPER_ADMIN par défaut.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['DRIVERS_DELETE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.drivers.remove(id, user, context);
  }
}

/**
 * Profil du livreur connecté.
 *
 * Aucun identifiant en paramètre : le livreur ne peut agir que sur
 * lui-même.
 */
@ApiTags('Drivers')
@Controller('driver')
@Roles(Role.DRIVER)
export class DriverProfileController {
  constructor(private readonly drivers: DriversService) {}

  @Get('dashboard')
  @ApiEndpoint({
    summary: 'Mon tableau de bord',
    description: 'Courses du jour, gains du jour, disponibilité et statistiques.',
    roles: [Role.DRIVER],
  })
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.dashboard(user);
  }

  @Get('stats')
  @ApiEndpoint({ summary: 'Mes statistiques', roles: [Role.DRIVER] })
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.drivers.stats(user.driverProfileId!);
  }

  @Patch('availability')
  @ApiEndpoint({
    summary: 'Passer en ligne / hors ligne',
    description:
      'La disponibilité est déduite du travail en cours : un livreur en course ne peut pas se déclarer disponible.',
    roles: [Role.DRIVER],
  })
  updateAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDriverAvailabilityDto,
  ) {
    return this.drivers.updateAvailability(user, dto);
  }
}
