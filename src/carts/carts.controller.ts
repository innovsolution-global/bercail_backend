import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, CurrentUser, Roles } from '../common/decorators';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CartsService } from './carts.service';
import { AddCartItemDto, CartQueryDto, UpdateCartItemDto } from './dto/cart.dto';

/**
 * Panier du client connecté.
 *
 * Toutes les réponses renvoient le panier complet recalculé : l'application
 * mobile n'a jamais à additionner quoi que ce soit elle-même.
 */
@ApiTags('Orders')
@Controller('cart')
@Roles(Role.CUSTOMER)
export class CartsController {
  constructor(private readonly carts: CartsService) {}

  @Get()
  @ApiEndpoint({
    summary: 'Mon panier',
    description:
      'Prix recalculés à chaque appel. `promotionCode` permet de simuler une remise avant commande.',
    roles: [Role.CUSTOMER],
  })
  get(@CurrentUser() user: AuthenticatedUser, @Query() query: CartQueryDto) {
    return this.carts.get(user.id, query);
  }

  @Post('items')
  @ApiEndpoint({
    summary: 'Ajouter un plat au panier',
    description: 'Les lignes identiques (mêmes options, même note) fusionnent.',
    roles: [Role.CUSTOMER],
  })
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.carts.addItem(user.id, dto);
  }

  @Patch('items/:itemId')
  @ApiEndpoint({
    summary: 'Modifier une ligne du panier',
    description: 'Une quantité à 0 retire la ligne.',
    roles: [Role.CUSTOMER],
  })
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.carts.updateItem(user.id, itemId, dto);
  }

  @Delete('items/:itemId')
  @ApiEndpoint({ summary: 'Retirer une ligne du panier', roles: [Role.CUSTOMER] })
  removeItem(@CurrentUser() user: AuthenticatedUser, @Param('itemId') itemId: string) {
    return this.carts.removeItem(user.id, itemId);
  }

  @Delete()
  @ApiEndpoint({ summary: 'Vider le panier', roles: [Role.CUSTOMER] })
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.carts.clear(user.id);
  }
}
