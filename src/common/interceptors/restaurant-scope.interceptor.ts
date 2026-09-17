import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Observable } from 'rxjs';
import { restaurantContext } from '../context/restaurant-context';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Ouvre le périmètre d'établissement de la requête.
 *
 * Monté après les gardes — l'utilisateur est donc déjà authentifié quand
 * cet intercepteur s'exécute, ce qui compte : l'authentification elle-même
 * doit pouvoir chercher un compte par son e-mail sans cloisonnement, et
 * elle passe avant.
 *
 * Qui voit quoi :
 *
 *  • **ADMIN, DRIVER** — rattachés à un établissement, ils ne voient que
 *    le leur. C'est le cas qui justifie tout le dispositif.
 *  • **SUPER_ADMIN** — le propriétaire les voit tous. Il peut restreindre
 *    sa vue à un établissement via le paramètre d'URL `restaurantId`, que
 *    le middleware a extrait : c'est ainsi que le sélecteur du back-office
 *    fonctionne.
 *  • **CUSTOMER** — sans rattachement : un client commande où il veut, et
 *    ses données (adresses, panier, favoris) ne sont pas cloisonnées.
 */
@Injectable()
export class RestaurantScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser & { restaurantId?: string | null };
      requestedRestaurantId?: string;
      clientPosition?: { latitude: number; longitude: number };
    }>();

    const user = request.user;
    const position = request.clientPosition ?? null;

    /*
     * Route publique : rien à cloisonner, rien à filtrer.
     *
     * Mais si l'application dit où elle est, on le retient : c'est ce qui
     * permet à un visiteur pas encore inscrit, debout à Kipé, de voir la
     * carte de Kipé plutôt que celle de la maison la plus ancienne. Sans
     * position, on ne pose aucun contexte — l'authentification, elle,
     * doit pouvoir chercher un compte par son e-mail sans périmètre.
     */
    if (!user) {
      if (!position) return next.handle();
      return restaurantContext.run(
        { restaurantId: null, unrestricted: true, position },
        () => next.handle(),
      );
    }

    if (user.role === Role.SUPER_ADMIN) {
      const chosen = request.requestedRestaurantId;

      /*
       * Un identifiant qui n'a pas la forme attendue est refusé.
       *
       * Sans ce contrôle, une valeur périmée — une adresse fermée, un
       * reliquat de données simulées — ne provoque aucune erreur : elle
       * filtre simplement **tout** à zéro, et chaque écran paraît vide sans
       * que rien n'en dise la cause. Un refus explicite vaut mieux qu'un
       * silence trompeur.
       *
       * Le contrôle reste volontairement formel : vérifier l'existence
       * demanderait une lecture en base à chaque requête, pour un gain
       * marginal — un identifiant bien formé mais inconnu reste possible,
       * et le sélecteur du back-office le corrige de lui-même.
       */
      if (chosen && !UUID.test(chosen)) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'Établissement sélectionné invalide. Revenez à la vue d’ensemble.',
        );
      }

      return restaurantContext.run(
        chosen
          ? { restaurantId: chosen, unrestricted: false }
          : { restaurantId: null, unrestricted: true },
        () => next.handle(),
      );
    }

    /*
     * Un client n'appartient à aucun établissement : le cloisonner
     * l'empêcherait de commander ailleurs.
     *
     * Son identifiant est tout de même porté par le contexte : il ne
     * sert pas à filtrer ses données, mais à savoir **quelle maison le
     * sert** — la plus proche de son adresse. Voir
     * [[RestaurantRouter]].
     */
    if (user.role === Role.CUSTOMER) {
      return restaurantContext.run(
        { restaurantId: null, unrestricted: true, customerId: user.id, position },
        () => next.handle(),
      );
    }

    return restaurantContext.run(
      { restaurantId: user.restaurantId ?? null, unrestricted: false },
      () => next.handle(),
    );
  }
}

/** Format des identifiants de l'application : tous les modèles sont en UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
