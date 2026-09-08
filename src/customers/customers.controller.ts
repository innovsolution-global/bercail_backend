import { Body, Controller, Get, Param, Patch, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import {
  ApiEndpoint,
  Ctx,
  CurrentUser,
  RequirePermissions,
  Roles,
} from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { buildCsv, csvResponse } from '../common/utils/csv.util';
import { AuthService } from '../auth/auth.service';
import { OrdersService } from '../orders/orders.service';
import { CustomersService } from './customers.service';
import { CustomerQueryDto, UpdateCustomerDto, UpdateProfileDto } from './dto/customer.dto';
import { UpdateAccountStatusDto } from '../drivers/dto/driver.dto';
import { OrderQueryDto } from '../orders/dto/order.dto';

/**
 * Gestion des clients — back-office.
 */
@ApiTags('Customers')
@Controller('customers')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly ordersService: OrdersService,
  ) {}

  @Get()
  @RequirePermissions('CUSTOMERS_READ')
  @ApiEndpoint({
    summary: 'Lister les clients',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_READ'],
    paginated: true,
  })
  list(@Query() query: CustomerQueryDto) {
    return this.customers.list(query);
  }

  @Get('export')
  @RequirePermissions('CUSTOMERS_EXPORT')
  @ApiEndpoint({
    summary: 'Exporter les clients (CSV)',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_EXPORT'],
  })
  async export(@Query() query: CustomerQueryDto, @Res({ passthrough: true }) response: Response) {
    const rows = await this.customers.exportRows(query);

    const csv = buildCsv(rows, [
      { header: 'Nom', value: (row) => String(row.fullName ?? '') },
      { header: 'Téléphone', value: (row) => String(row.phone ?? '') },
      { header: 'E-mail', value: (row) => String(row.email ?? '') },
      { header: 'Statut', value: (row) => String(row.status ?? '') },
      { header: 'Commandes', value: (row) => Number(row.ordersCount ?? 0) },
      { header: 'Total dépensé (GNF)', value: (row) => Number(row.totalSpent ?? 0) },
      { header: 'Points fidélité', value: (row) => Number(row.loyaltyPoints ?? 0) },
      { header: 'Dernière commande', value: (row) => String(row.lastOrderAt ?? '') },
      { header: 'Inscrit le', value: (row) => String(row.createdAt ?? '') },
    ]);

    return csvResponse(response, 'clients', csv);
  }

  @Get(':id')
  @RequirePermissions('CUSTOMERS_READ')
  @ApiEndpoint({
    summary: 'Fiche client',
    description: 'Adresses, panier moyen, commandes annulées et dernière activité.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.customers.findOne(id);
  }

  @Get(':id/summary')
  @RequirePermissions('CUSTOMERS_READ')
  @ApiEndpoint({
    summary: 'Statistiques d’un client',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_READ'],
  })
  summary(@Param('id') id: string) {
    return this.customers.summary(id);
  }

  @Get(':id/orders')
  @RequirePermissions('CUSTOMERS_READ', 'ORDERS_READ')
  @ApiEndpoint({
    summary: 'Commandes d’un client',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_READ', 'ORDERS_READ'],
    paginated: true,
  })
  customerOrders(@Param('id') id: string, @Query() query: OrderQueryDto) {
    query.customerId = id;
    return this.ordersService.listForBackOffice(query);
  }

  @Patch(':id')
  @RequirePermissions('CUSTOMERS_UPDATE')
  @ApiEndpoint({
    summary: 'Corriger une fiche client',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_UPDATE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.customers.update(id, dto, user, context);
  }

  @Patch(':id/status')
  @RequirePermissions('CUSTOMERS_SUSPEND')
  @ApiEndpoint({
    summary: 'Suspendre ou réactiver un client',
    description: 'Ferme immédiatement toutes ses sessions. Action auditée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['CUSTOMERS_SUSPEND'],
  })
  setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAccountStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.customers.setStatus(id, dto.status, user, context, dto.reason);
  }
}

/**
 * Profil du client connecté (application mobile).
 */
@ApiTags('Customers')
@Controller('me')
@Roles(Role.CUSTOMER)
export class CustomerProfileController {
  constructor(
    private readonly customers: CustomersService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @ApiEndpoint({
    summary: 'Mon profil',
    description: 'Profil complet : coordonnées, adresses, fidélité et historique résumé.',
    roles: [Role.CUSTOMER],
  })
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.customers.profile(user.id);
  }

  @Patch()
  @ApiEndpoint({
    summary: 'Modifier mon profil',
    description: "L'e-mail n'est pas modifiable ici : il sert d'identifiant de connexion.",
    roles: [Role.CUSTOMER],
  })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @Ctx() context: RequestContext,
  ) {
    // Même écriture que `PATCH /auth/me` : une seule logique, deux formes
    // de réponse (ici, le profil client complet attendu par l'application).
    await this.auth.updateProfile(user, dto, context);
    return this.customers.profile(user.id);
  }
}
