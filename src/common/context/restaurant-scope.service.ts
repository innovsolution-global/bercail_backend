import { Injectable } from '@nestjs/common';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import { restaurantContext } from './restaurant-context';

/**
 * Résolution de l'établissement d'écriture.
 *
 * La lecture est cloisonnée automatiquement par le client Prisma. L'écriture,
 * elle, pose une question que la machine ne peut pas trancher seule : pour
 * **quel** établissement crée-t-on cette dépense ?
 *
 * La réponse dépend du compte :
 *
 *  • un **ADMIN** est rattaché à un établissement, et ne peut écrire que
 *    là — ce qu'il demanderait d'autre est ignoré, pas refusé, parce que
 *    l'interface ne lui propose de toute façon pas le choix ;
 *  • un **SUPER_ADMIN** les voit tous, donc aucun ne s'impose : il doit
 *    désigner celui qu'il vise, sans quoi la donnée serait orpheline.
 */
@Injectable()
export class RestaurantScopeService {
  /** Établissement courant, ou `null` pour un compte non cloisonné. */
  current(): string | null {
    return restaurantContext.activeRestaurantId();
  }

  /**
   * Établissement dans lequel écrire.
   *
   * @param requested Établissement demandé par l'appelant, s'il en désigne un.
   */
  resolve(requested?: string | null): string {
    const own = restaurantContext.activeRestaurantId();

    // Un compte cloisonné écrit chez lui, quoi qu'il demande.
    if (own) return own;

    if (requested) return requested;

    throw AppException.badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      'Choisissez l’établissement concerné.',
    );
  }
}
