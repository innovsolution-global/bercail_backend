import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
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
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { buildCsv, csvResponse } from '../common/utils/csv.util';
import {
  ConfirmPaymentDto,
  FailPaymentDto,
  InitiatePaymentDto,
  PaymentQueryDto,
  RefundPaymentDto,
} from './dto/payment.dto';
import { ChapChapService } from './chapchap.service';
import { PaymentsService } from './payments.service';

/**
 * Paiements.
 *
 * Le client déclenche et suit le paiement de ses commandes ; le
 * back-office consulte, rapproche et rembourse.
 */
@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly chapchap: ChapChapService,
  ) {}

  @Get()
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PAYMENTS_READ')
  @ApiEndpoint({
    summary: 'Lister les paiements',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PAYMENTS_READ'],
    paginated: true,
  })
  list(@Query() query: PaymentQueryDto) {
    return this.payments.list(query);
  }

  @Get('provider')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PAYMENTS_READ')
  @ApiEndpoint({
    summary: 'État de l’opérateur de paiement',
    description:
      'Intégration active ou non, adresse de rappel à déclarer chez l’opérateur, et alertes de configuration. Aucune clé n’est renvoyée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PAYMENTS_READ'],
  })
  provider() {
    return this.chapchap.status();
  }

  @Get('export')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequirePermissions('PAYMENTS_EXPORT')
  @ApiEndpoint({
    summary: 'Exporter les paiements (CSV)',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PAYMENTS_EXPORT'],
  })
  async export(@Query() query: PaymentQueryDto, @Res({ passthrough: true }) response: Response) {
    const rows = await this.payments.exportRows(query);

    const csv = buildCsv(rows, [
      { header: 'Transaction', value: (row) => String(row.transactionRef ?? '') },
      { header: 'Commande', value: (row) => String(row.orderReference ?? '') },
      { header: 'Client', value: (row) => String(row.customerName ?? '') },
      { header: 'Méthode', value: (row) => String(row.method ?? '') },
      { header: 'Statut', value: (row) => String(row.status ?? '') },
      { header: 'Montant (GNF)', value: (row) => Number(row.amount ?? 0) },
      { header: 'Frais (GNF)', value: (row) => Number(row.fee ?? 0) },
      { header: 'Payé le', value: (row) => String(row.paidAt ?? '') },
      { header: 'Remboursé le', value: (row) => String(row.refundedAt ?? '') },
      { header: 'Créé le', value: (row) => String(row.createdAt ?? '') },
    ]);

    return csvResponse(response, 'paiements', csv);
  }

  @Get('order/:orderId')
  @ApiEndpoint({
    summary: 'Paiement d’une commande',
    description: 'Accessible au client propriétaire de la commande et au back-office.',
    roles: [Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN],
  })
  findForOrder(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.payments.findForOrder(user, orderId);
  }

  @Get(':id')
  @ApiEndpoint({
    summary: 'Détail d’un paiement',
    roles: [Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PAYMENTS_READ'],
  })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.payments.findOne(user, id);
  }

  @Post('order/:orderId/initiate')
  @Roles(Role.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @Idempotent({ ttlHours: 6 })
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiEndpoint({
    summary: 'Déclencher le paiement d’une commande',
    description:
      'Le montant est relu sur la commande : aucun montant envoyé par le client n’est accepté. Le numéro mobile money n’est stocké que tronqué.',
    roles: [Role.CUSTOMER],
  })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: InitiatePaymentDto,
    @Ctx() context: RequestContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.payments.initiate(user, orderId, dto, context, idempotencyKey);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 300_000 } })
  @ApiEndpoint({
    summary: 'Confirmer un paiement',
    description:
      "En production, cette logique est déclenchée par le rappel signé de l'opérateur. En bac à sable, elle permet de dérouler le parcours complet.",
    roles: [Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN],
  })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmPaymentDto,
    @Ctx() context: RequestContext,
  ) {
    return this.payments.confirm(id, user, context, dto.providerRef);
  }

  @Post(':id/abandon')
  @Roles(Role.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 300_000 } })
  @ApiEndpoint({
    summary: 'Abandonner un paiement en cours',
    description:
      "Appelée quand le client referme la page de l'opérateur. L'état est d'abord redemandé à l'opérateur : un paiement qui vient d'aboutir n'est pas annulé par la fermeture.",
    roles: [Role.CUSTOMER],
  })
  abandon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Ctx() context: RequestContext,
  ) {
    return this.payments.abandon(id, user, context);
  }

  @Post(':id/fail')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('PAYMENTS_READ')
  @ApiEndpoint({
    summary: 'Marquer un paiement en échec',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PAYMENTS_READ'],
  })
  fail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FailPaymentDto,
    @Ctx() context: RequestContext,
  ) {
    return this.payments.markFailed(id, dto.reason, user, context);
  }

  @Post(':id/refund')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('PAYMENTS_REFUND')
  @ApiEndpoint({
    summary: 'Rembourser un paiement',
    description:
      'Seul un paiement encaissé peut être remboursé, une seule fois, avec un motif obligatoire. Action auditée.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PAYMENTS_REFUND'],
  })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
    @Ctx() context: RequestContext,
  ) {
    return this.payments.refund(id, dto, user, context);
  }
}
