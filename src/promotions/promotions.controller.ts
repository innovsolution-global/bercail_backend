import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
import {
  CreatePromotionDto,
  PromotionQueryDto,
  SetPromotionActiveDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import { PromotionsService } from './promotions.service';

/**
 * Promotions — gestion par le back-office.
 */
@ApiTags('Promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PROMOTIONS_READ')
  @ApiEndpoint({
    summary: 'Lister les promotions',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_READ'],
    paginated: true,
  })
  list(@Query() query: PromotionQueryDto) {
    return this.promotions.list(query);
  }

  @Get('active')
  @Roles(Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiEndpoint({
    summary: 'Promotions en cours',
    description: 'Codes actuellement valables, tels qu’affichés dans l’application mobile.',
    roles: [Role.CUSTOMER],
  })
  publicList() {
    return this.promotions.publicList();
  }

  @Get('check/:code')
  @Roles(Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiEndpoint({
    summary: 'Vérifier un code promotionnel',
    description:
      'Contrôle la validité et la période. Le montant de la remise, lui, est calculé au moment du devis ou de la commande.',
    roles: [Role.CUSTOMER],
  })
  check(@Param('code') code: string, @CurrentUser() user?: AuthenticatedUser) {
    const isBackOffice = user?.role === Role.ADMIN || user?.role === Role.SUPER_ADMIN;
    return this.promotions.check(code, !isBackOffice);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PROMOTIONS_READ')
  @ApiEndpoint({
    summary: 'Détail d’une promotion',
    description: 'Inclut les 50 dernières utilisations.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.promotions.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PROMOTIONS_CREATE')
  @ApiEndpoint({
    summary: 'Créer une promotion',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_CREATE'],
  })
  create(
    @Body() dto: CreatePromotionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.promotions.create(dto, user, context);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PROMOTIONS_UPDATE')
  @ApiEndpoint({
    summary: 'Modifier une promotion',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_UPDATE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.promotions.update(id, dto, user, context);
  }

  @Patch(':id/active')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PROMOTIONS_UPDATE')
  @ApiEndpoint({
    summary: 'Activer ou désactiver une promotion',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_UPDATE'],
  })
  setActive(
    @Param('id') id: string,
    @Body() dto: SetPromotionActiveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.promotions.setActive(id, dto.isActive, user, context);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PROMOTIONS_DELETE')
  @ApiEndpoint({
    summary: 'Supprimer une promotion (logique)',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_DELETE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.promotions.remove(id, user, context);
  }
}
