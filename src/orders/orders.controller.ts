import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import {
  ApiEndpoint,
  Ctx,
  CurrentUser,
  Idempotent,
  RequirePermissions,
  Roles,
} from '../common/decorators';
import type { Permission } from '../common/constants/permissions.constant';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { buildCsv, csvResponse } from '../common/utils/csv.util';
import { CartsService } from '../carts/carts.service';
import {
  CancelOrderDto,
  CreateOrderDto,
  CustomerOrderQueryDto,
  OrderQueryDto,
  QuoteOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { OrdersService } from './orders.service';

/**
 * Commandes — route unique pour les quatre rôles.
 *
 * `GET /orders` renvoie ses propres commandes à un client et l'ensemble
 * du carnet à un gestionnaire : c'est le serveur qui décide du périmètre,
 * jamais un paramètre envoyé par le client.
 */
@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly carts: CartsService,
  ) {}

  @Post()
  @Roles(Role.CUSTOMER)
  @Idempotent({ ttlHours: 24 })
  @Throttle({ default: { limit: 20, ttl: 300_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Clé unique de la tentative. Une seconde requête portant la même clé renvoie la première réponse au lieu de créer un doublon.',
  })
  @ApiEndpoint({
    summary: 'Créer une commande',
    description:
      'À partir du panier, ou d’une liste d’articles fournie. Tous les montants sont recalculés par le serveur : aucun total envoyé par le client n’est accepté.',
    roles: [Role.CUSTOMER],
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
    @Ctx() context: RequestContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const fromCart = !dto.items?.length;

    // Le panier n'est lu que si l'idempotence laisse passer la requête.
    return this.orders.create(user, dto, context, {
      idempotencyKey,
      fromCart,
      loadCartLines: () => this.carts.toLineInputs(user.id),
    });
  }

  @Post('quote')
  @Roles(Role.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Simuler le prix d’une commande',
    description:
      'Renvoie sous-total, frais de livraison, remise et total exactement tels qu’ils seront facturés.',
    roles: [Role.CUSTOMER],
  })
  async quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuoteOrderDto) {
    const cartLines = dto.items?.length ? undefined : await this.carts.toLineInputs(user.id);
    return this.orders.quote(user.id, dto, cartLines);
  }

  @Get()
  @ApiEndpoint({
    summary: 'Lister les commandes',
    description:
      'CUSTOMER : ses commandes. ADMIN / SUPER_ADMIN : toutes, avec filtres (statut, paiement, période, livreur, client).',
    roles: [Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['ORDERS_READ'],
    paginated: true,
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OrderQueryDto & CustomerOrderQueryDto,
  ) {
    if (user.role === Role.CUSTOMER) {
      return this.orders.listForCustomer(user.id, query);
    }

    if (user.role === Role.DRIVER) {
      // Un livreur consulte ses courses via /driver/deliveries, pas ici.
      return this.orders.listForCustomer(user.id, query);
    }

    this.assertPermission(user, 'ORDERS_READ');
    return this.orders.listForBackOffice(query);
  }

  @Get('export')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('ORDERS_EXPORT')
  @ApiEndpoint({
    summary: 'Exporter les commandes (CSV)',
    description: 'Le fichier est produit par le serveur, avec les mêmes filtres que la liste.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['ORDERS_EXPORT'],
  })
  async export(@Query() query: OrderQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.orders.listForBackOffice({ ...query, page: 1, limit: 100 } as OrderQueryDto);
    const rows = result.data as Record<string, unknown>[];

    const csv = buildCsv(rows, [
      { header: 'Référence', value: (row) => String(row.reference ?? '') },
      { header: 'Date', value: (row) => String(row.createdAt ?? '') },
      { header: 'Client', value: (row) => String(row.customerName ?? '') },
      { header: 'Téléphone', value: (row) => String(row.customerPhone ?? '') },
      { header: 'Type', value: (row) => String(row.type ?? '') },
      { header: 'Statut', value: (row) => String(row.status ?? '') },
      { header: 'Articles', value: (row) => Number(row.itemsCount ?? 0) },
      { header: 'Total (GNF)', value: (row) => Number(row.total ?? 0) },
      { header: 'Paiement', value: (row) => String(row.paymentMethod ?? '') },
      { header: 'Statut paiement', value: (row) => String(row.paymentStatus ?? '') },
      { header: 'Livreur', value: (row) => String(row.driverName ?? '') },
    ]);

    return csvResponse(response, 'commandes', csv);
  }

  @Get(':id')
  @ApiEndpoint({
    summary: 'Détail d’une commande',
    description:
      'Appartenance vérifiée : un client ne lit que ses commandes, un livreur uniquement celles qui lui sont assignées.',
    roles: [Role.CUSTOMER, Role.DRIVER, Role.ADMIN, Role.SUPER_ADMIN],
  })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.findOne(user, id);
  }

  @Get(':id/tracking')
  @ApiEndpoint({
    summary: 'Suivi d’une commande',
    description:
      'Vue allégée pour l’écran de suivi : statuts, horaires estimés et, si une livraison est en cours, la position du livreur.',
    roles: [Role.CUSTOMER, Role.DRIVER, Role.ADMIN, Role.SUPER_ADMIN],
  })
  tracking(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.tracking(user, id);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiEndpoint({
    summary: 'Faire avancer une commande',
    description:
      'Transitions contrôlées côté serveur. La permission exigée dépend de la transition : avancer relève de ORDERS_UPDATE_STATUS, annuler de ORDERS_CANCEL.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['ORDERS_UPDATE_STATUS'],
  })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @Ctx() context: RequestContext,
  ) {
    return this.orders.updateStatus(user, id, dto, context);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Annuler une commande',
    description:
      'Le client peut annuler tant que la commande n’est pas en préparation et dans le délai configuré. Le back-office peut annuler à tout moment avec la permission ORDERS_CANCEL. Action auditée.',
    roles: [Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['ORDERS_CANCEL'],
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Ctx() context: RequestContext,
  ) {
    return this.orders.cancel(user, id, dto, context);
  }

  /**
   * `GET /orders` sert quatre rôles : la permission ne peut donc pas être
   * posée par un guard sur la route, elle est vérifiée ici pour la seule
   * branche back-office.
   */
  private assertPermission(user: AuthenticatedUser, permission: Permission): void {
    if (user.role === Role.SUPER_ADMIN) return;
    if (!user.permissions.includes(permission)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Vous n'avez pas les permissions nécessaires.",
        { required: [permission] },
      );
    }
  }
}
