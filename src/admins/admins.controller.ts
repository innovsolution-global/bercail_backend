import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { AdminsService } from './admins.service';
import {
  AdminQueryDto,
  AdminStatusDto,
  CreateAdminDto,
  UpdateAdminDto,
  UpdateAdminPermissionsDto,
} from './dto/admin.dto';

/**
 * Administration des comptes du back-office.
 *
 * Deux chemins, un seul contrôleur : `/administrators` (consommé par le
 * back-office React) et `/super-admin/admins` (chemin du contrat d'API).
 *
 * Le rôle SUPER_ADMIN est exigé en plus des permissions : même un ADMIN à
 * qui l'on aurait accordé `USERS_*` par erreur ne passerait pas.
 */
@ApiTags('SuperAdmin')
@Controller(['administrators', 'super-admin/admins'])
@Roles(Role.SUPER_ADMIN)
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  @RequirePermissions('USERS_READ')
  @ApiEndpoint({
    summary: 'Lister les administrateurs',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_READ'],
    paginated: true,
  })
  list(@Query() query: AdminQueryDto) {
    return this.admins.list(query);
  }

  @Post()
  @RequirePermissions('USERS_CREATE')
  @ApiEndpoint({
    summary: 'Créer un administrateur',
    description:
      "Le compte est créé PENDING avec un lien d'activation. Aucun mot de passe n'est transmis, et cette route ne peut pas créer de SUPER_ADMIN. Action auditée.",
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_CREATE'],
  })
  create(
    @Body() dto: CreateAdminDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.admins.create(dto, user, context);
  }

  @Get(':id')
  @RequirePermissions('USERS_READ')
  @ApiEndpoint({
    summary: 'Fiche d’un administrateur',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.admins.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('USERS_UPDATE')
  @ApiEndpoint({
    summary: 'Modifier un administrateur',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_UPDATE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.admins.update(id, dto, user, context);
  }

  @Patch(':id/status')
  @RequirePermissions('USERS_SUSPEND')
  @ApiEndpoint({
    summary: 'Suspendre ou réactiver un administrateur',
    description: 'Ferme immédiatement toutes ses sessions. Action auditée.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_SUSPEND'],
  })
  setStatus(
    @Param('id') id: string,
    @Body() dto: AdminStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.admins.setStatus(id, dto.status, user, context, dto.reason);
  }

  @Patch(':id/permissions')
  @RequirePermissions('USERS_PERMISSIONS')
  @ApiEndpoint({
    summary: 'Attribuer les permissions d’un administrateur',
    description:
      'La liste envoyée remplace intégralement les permissions du compte. Les permissions réservées au SUPER_ADMIN sont refusées. Action auditée avec le différentiel avant/après.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_PERMISSIONS'],
  })
  setPermissions(
    @Param('id') id: string,
    @Body() dto: UpdateAdminPermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.admins.setPermissions(id, dto.permissions, user, context);
  }

  @Post(':id/resend-activation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('USERS_CREATE')
  @ApiEndpoint({
    summary: 'Renvoyer le lien d’activation',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_CREATE'],
  })
  resendActivation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.admins.resendActivation(id, user, context);
  }

  @Delete(':id')
  @RequirePermissions('USERS_DELETE')
  @ApiEndpoint({
    summary: 'Supprimer un administrateur (logique)',
    description: 'Le journal d’audit conserve ses actions passées. Action auditée.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['USERS_DELETE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.admins.remove(id, user, context);
  }
}
