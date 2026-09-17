import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, CurrentUser, Roles } from '../common/decorators';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ReviewsService } from './reviews.service';

/**
 * Les avis, vus par celui qui les a donnés.
 *
 * Déposer un avis se fait sur la commande (`POST /orders/:id/review`) ;
 * ici, on relit ce qu'on a déjà dit — pour que la fiche d'un plat
 * affiche « votre note » depuis le serveur, et non depuis la mémoire du
 * téléphone.
 */
@ApiTags('Orders')
@Controller('reviews')
@Roles(Role.CUSTOMER)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('mine/dishes')
  @ApiEndpoint({
    summary: 'Mes notes de plats',
    description: 'La dernière note donnée à chaque plat, toutes commandes confondues.',
    roles: [Role.CUSTOMER],
  })
  myDishRatings(@CurrentUser() user: AuthenticatedUser) {
    return this.reviews.myDishRatings(user);
  }
}
