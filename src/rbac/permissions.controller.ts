import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, RequireAnyPermission, Roles } from '../common/decorators';
import { PermissionsService } from './permissions.service';

/**
 * Catalogue des permissions.
 *
 * Il alimente l'écran « Permissions » du back-office : celui-ci n'invente
 * jamais la liste des droits, il la demande au backend.
 */
@ApiTags('SuperAdmin')
@Controller(['permissions', 'super-admin/permissions'])
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  @RequireAnyPermission('USERS_PERMISSIONS', 'USERS_READ')
  @ApiEndpoint({
    summary: 'Catalogue des permissions',
    description:
      'Permissions groupées par module, socles par rôle et liste des permissions non délégables.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['USERS_PERMISSIONS'],
  })
  catalog() {
    return this.permissions.getCatalog();
  }
}
