import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { CreatePosOrderDto, QuotePosOrderDto } from './dto/pos.dto';
import { PosService } from './pos.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Caisse du restaurant.
 *
 * Les ventes au comptoir rejoignent la table des commandes : elles
 * apparaissent dans la liste des commandes, dans les paiements et dans le
 * chiffre d'affaires, au même titre que celles de l'application mobile.
 */
@ApiTags('Caisse')
@Controller('pos')
@Roles(...BACK_OFFICE)
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Post('quote')
  @RequirePermissions('POS_SELL')
  @ApiEndpoint({
    summary: 'Calculer un ticket',
    description:
      'Renvoie le détail des lignes et le total à encaisser. Aucun montant n’est accepté du client : le serveur relit les prix en base.',
    roles: [...BACK_OFFICE],
    permissions: ['POS_SELL'],
  })
  quote(@Body() dto: QuotePosOrderDto) {
    return this.pos.quote(dto);
  }

  @Post('orders')
  @RequirePermissions('POS_SELL')
  @Throttle({ default: { limit: 60, ttl: 300_000 } })
  @ApiEndpoint({
    summary: 'Enregistrer une vente au comptoir',
    description:
      'Crée la commande, ses lignes et son paiement en une transaction. Par défaut, la vente est servie et encaissée immédiatement.',
    roles: [...BACK_OFFICE],
    permissions: ['POS_SELL'],
  })
  create(
    @Body() dto: CreatePosOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.pos.create(dto, user, context);
  }

  @Get('today')
  @RequirePermissions('POS_SELL')
  @ApiEndpoint({
    summary: 'Caisse du jour',
    description: 'Nombre de ventes, recette, remises accordées et répartition par règlement.',
    roles: [...BACK_OFFICE],
    permissions: ['POS_SELL'],
  })
  today() {
    return this.pos.today();
  }
}
