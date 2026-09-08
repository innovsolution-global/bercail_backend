import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, CurrentUser, Roles } from '../common/decorators';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SearchService } from './search.service';

/**
 * Recherche globale — une route, quatre périmètres.
 */
@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiEndpoint({
    summary: 'Recherche globale',
    description:
      'Le périmètre dépend du rôle : la carte et ses commandes pour un client, ses courses pour un livreur, commandes / clients / livreurs / plats pour le back-office (selon ses permissions).',
    roles: [Role.CUSTOMER, Role.DRIVER, Role.ADMIN, Role.SUPER_ADMIN],
  })
  globalSearch(@CurrentUser() user: AuthenticatedUser, @Query('q') term = '') {
    return this.search.search(user, term);
  }

  @Get('counts')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiEndpoint({
    summary: 'Compteurs rapides du back-office',
    description: 'Commandes en attente, courses en cours, plats en rupture.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
  })
  counts() {
    return this.search.quickCounts();
  }
}
