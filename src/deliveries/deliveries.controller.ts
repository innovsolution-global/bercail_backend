import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DeliveryStatus, Role } from '@prisma/client';
import {
  ApiEndpoint,
  Ctx,
  CurrentUser,
  RequirePermissions,
  Roles,
} from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { DeliveriesService } from './deliveries.service';
import { DriverAssignmentService } from './driver-assignment.service';
import {
  AssignableDriversQueryDto,
  CompleteDeliveryDto,
  DeclineDeliveryDto,
  DeliveryQueryDto,
  DriverDeliveryQueryDto,
  FailDeliveryDto,
  UpdateDeliveryStatusDto,
  UpdateLocationDto,
} from './dto/delivery.dto';

/**
 * Livraisons — supervision par le back-office.
 */
@ApiTags('Deliveries')
@Controller('deliveries')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @RequirePermissions('DELIVERIES_READ')
  @ApiEndpoint({
    summary: 'Lister les livraisons',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DELIVERIES_READ'],
    paginated: true,
  })
  list(@Query() query: DeliveryQueryDto) {
    return this.deliveries.list(query);
  }

  @Get('active')
  @RequirePermissions('DELIVERIES_TRACK')
  @ApiEndpoint({
    summary: 'Courses en cours',
    description: 'Écran de supervision : toutes les courses actives avec la position des livreurs.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DELIVERIES_TRACK'],
  })
  active() {
    return this.deliveries.active();
  }

  @Get(':id')
  @RequirePermissions('DELIVERIES_READ')
  @ApiEndpoint({
    summary: 'Détail d’une livraison',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DELIVERIES_READ'],
  })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.deliveries.findOne(user, id);
  }

  @Get(':id/trail')
  @RequirePermissions('DELIVERIES_TRACK')
  @ApiEndpoint({
    summary: 'Trace GPS d’une course',
    description: 'Points enregistrés pendant la course, dans l’ordre chronologique.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DELIVERIES_TRACK'],
  })
  trail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.deliveries.trail(user, id);
  }

  @Patch(':id/status')
  @RequirePermissions('DELIVERIES_UPDATE')
  @ApiEndpoint({
    summary: 'Corriger le statut d’une livraison',
    description:
      'Intervention du back-office en cas d’incident. Les transitions restent contrôlées par la machine à états. Action auditée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DELIVERIES_UPDATE'],
  })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.updateStatusByStaff(user, id, dto.status, context, dto.comment);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('DELIVERIES_UPDATE')
  @ApiEndpoint({
    summary: 'Déclarer une livraison en échec',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['DELIVERIES_UPDATE'],
  })
  fail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FailDeliveryDto,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.fail(user, id, dto.reason, context);
  }
}

/**
 * Attribution d'une commande à un livreur.
 *
 * La route vit sous `/orders/:orderId/assign` — c'est le geste métier du
 * gestionnaire — mais le code appartient au module des livraisons.
 */
@ApiTags('Deliveries')
@Controller('orders')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class OrderAssignmentController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly assignment: DriverAssignmentService,
  ) {}

  @Post(':orderId/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ORDERS_ASSIGN_DRIVER')
  @ApiEndpoint({
    summary: 'Attribuer une commande à un livreur',
    description:
      'Vérifie que le livreur est actif, en ligne et non suspendu, crée la course, génère le code de remise du client et prévient le livreur en temps réel. Réattribution possible tant que la course n’est pas terminée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['ORDERS_ASSIGN_DRIVER'],
  })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: { driverId: string; comment?: string },
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.assign(orderId, dto.driverId, user, context, dto.comment);
  }

  @Get(':orderId/assignable-drivers')
  @RequirePermissions('ORDERS_ASSIGN_DRIVER')
  @ApiEndpoint({
    summary: 'Livreurs proposables pour cette commande',
    description: 'Triés par charge, proximité puis note.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['ORDERS_ASSIGN_DRIVER'],
  })
  assignableForOrder(@Param('orderId') orderId: string, @Query() query: AssignableDriversQueryDto) {
    return this.assignment.assignable({ orderId, zone: query.zone });
  }
}

/**
 * Espace livreur.
 *
 * Toutes les routes sont implicitement limitées aux courses du livreur
 * connecté : aucune ne prend d'identifiant de livreur en paramètre.
 */
@ApiTags('Drivers')
@Controller('driver')
@Roles(Role.DRIVER)
export class DriverDeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get('deliveries')
  @ApiEndpoint({
    summary: 'Mes courses',
    description: '`scope=active` pour les courses en cours, `history` pour les terminées.',
    roles: [Role.DRIVER],
    paginated: true,
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: DriverDeliveryQueryDto) {
    return this.deliveries.listForDriver(user.driverProfileId!, query);
  }

  @Get('deliveries/:id')
  @ApiEndpoint({ summary: 'Détail d’une course', roles: [Role.DRIVER] })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.deliveries.findOneForDriver(user.driverProfileId!, id);
  }

  @Post('deliveries/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({ summary: 'Accepter une course', roles: [Role.DRIVER] })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.advance(user, id, DeliveryStatus.ACCEPTED, context);
  }

  @Post('deliveries/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Refuser une course',
    description:
      'Possible tant que la course n’a pas été acceptée. La commande retourne dans la file d’attribution et le back-office est prévenu.',
    roles: [Role.DRIVER],
  })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeclineDeliveryDto,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.decline(user, id, dto.reason, context);
  }

  @Post('deliveries/:id/arrived-restaurant')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({ summary: 'Je suis au restaurant', roles: [Role.DRIVER] })
  arrivedAtRestaurant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.advance(user, id, DeliveryStatus.ARRIVED_AT_RESTAURANT, context);
  }

  @Post('deliveries/:id/pickup')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'J’ai récupéré la commande',
    description: 'Bascule aussi la commande en « en cours de livraison ».',
    roles: [Role.DRIVER],
  })
  pickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.advance(user, id, DeliveryStatus.PICKED_UP, context);
  }

  @Post('deliveries/:id/start')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({ summary: 'Je pars livrer', roles: [Role.DRIVER] })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.advance(user, id, DeliveryStatus.IN_TRANSIT, context);
  }

  @Post('deliveries/:id/arrived')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({ summary: 'Je suis arrivé chez le client', roles: [Role.DRIVER] })
  arrived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.advance(user, id, DeliveryStatus.ARRIVED_AT_CUSTOMER, context);
  }

  @Post('deliveries/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Confirmer la remise avec le code du client',
    description:
      'Le code est la seule preuve acceptée. Protégé contre le rejeu, l’expiration et la force brute. Marque la course et la commande comme livrées.',
    roles: [Role.DRIVER],
  })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CompleteDeliveryDto,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.complete(user, id, dto, context);
  }

  @Post('deliveries/:id/fail')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Déclarer un échec de livraison',
    description: 'Client injoignable, adresse introuvable… Le back-office est notifié.',
    roles: [Role.DRIVER],
  })
  fail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FailDeliveryDto,
    @Ctx() context: RequestContext,
  ) {
    return this.deliveries.fail(user, id, dto.reason, context);
  }

  @Post('location')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Transmettre ma position',
    description:
      'Appelée régulièrement pendant une course. Le serveur horodate lui-même et ne diffuse la position qu’aux personnes concernées par la commande.',
    roles: [Role.DRIVER],
  })
  updateLocation(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateLocationDto) {
    return this.deliveries.updateLocation(user, dto);
  }
}
