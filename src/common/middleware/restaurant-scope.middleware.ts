import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Établissement demandé par l'appelant, extrait de l'URL. */
    requestedRestaurantId?: string;
  }
}

/**
 * Extrait l'établissement demandé, et le retire de l'URL.
 *
 * Le choix voyage en **paramètre d'URL** et non en en-tête, délibérément :
 * un en-tête personnalisé oblige le navigateur à demander une autorisation
 * préalable (le « pré-vol »), dont il met la réponse en cache. Un en-tête
 * ajouté après coup reste alors refusé pendant toute la durée de ce cache,
 * que le serveur ne peut pas invalider — et la panne se présente comme une
 * coupure réseau, sur une correction pourtant déjà déployée. Un paramètre
 * d'URL n'a aucun de ces défauts.
 *
 * Le paramètre est **retiré** de la requête avant la validation : le pipe
 * refuse tout champ inconnu, et c'est une règle qu'on ne veut pas assouplir
 * pour autant — c'est elle qui empêche un client de glisser un `total` ou
 * un `role` dans une requête.
 *
 * Ce middleware s'exécute avant les gardes : il ne sait donc pas encore qui
 * appelle. Il ne fait qu'extraire ; c'est l'intercepteur, après
 * authentification, qui décide si la demande est recevable.
 */
@Injectable()
export class RestaurantScopeMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const [path, search] = request.url.split('?');
    if (!search) return next();

    const params = new URLSearchParams(search);
    const requested = params.get('restaurantId');
    if (!requested) return next();

    request.requestedRestaurantId = requested;

    /*
     * On réécrit l'URL, et non `req.query`.
     *
     * Express 5 expose `query` comme un accesseur qui relit la chaîne de
     * requête à chaque lecture : y supprimer une clé n'a donc aucun effet
     * durable. Retirer le paramètre de l'URL est la seule façon qu'il
     * disparaisse aussi pour la validation, qui s'exécute plus loin.
     */
    params.delete('restaurantId');
    const rest = params.toString();
    request.url = rest ? `${path}?${rest}` : path;

    next();
  }
}
