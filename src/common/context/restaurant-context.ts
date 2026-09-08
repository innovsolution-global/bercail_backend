import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Établissement de la requête en cours.
 *
 * Le contexte suit la requête à travers toute la pile asynchrone : un
 * service appelé depuis un contrôleur sait de quel restaurant il parle
 * sans qu'on ait à lui passer l'information de main en main sur dix
 * niveaux.
 *
 * **Absence de contexte = aucun cloisonnement.** C'est volontaire, et c'est
 * ce qui permet à l'authentification de retrouver un compte par son
 * e-mail, au seed d'écrire, et à la synchronisation d'appliquer les
 * écritures du serveur pair. Ces chemins-là s'exécutent hors requête, donc
 * hors périmètre.
 */
export interface RestaurantScope {
  /** Établissement du compte. Nul pour un SUPER_ADMIN, qui les voit tous. */
  restaurantId: string | null;
  /** Vrai si le compte franchit les cloisons. */
  unrestricted: boolean;
}

const storage = new AsyncLocalStorage<RestaurantScope>();

export const restaurantContext = {
  /** Exécute le reste de la requête dans le périmètre d'un établissement. */
  run<T>(scope: RestaurantScope, handler: () => T): T {
    return storage.run(scope, handler);
  },

  /** Périmètre courant, ou `undefined` hors requête. */
  current(): RestaurantScope | undefined {
    return storage.getStore();
  },

  /**
   * Établissement à appliquer aux requêtes, ou `null` si rien ne doit être
   * filtré — hors requête, ou compte non cloisonné.
   */
  activeRestaurantId(): string | null {
    const scope = storage.getStore();
    if (!scope || scope.unrestricted) return null;
    return scope.restaurantId;
  },

  /**
   * Suspend le cloisonnement le temps d'une opération.
   *
   * Réservé aux traitements qui doivent légitimement traverser les
   * établissements : un rapport consolidé du propriétaire, la
   * synchronisation, une tâche planifiée. À utiliser sciemment — c'est la
   * seule porte de sortie, et elle doit rester visible dans le code.
   */
  unscoped<T>(handler: () => T): T {
    return storage.run({ restaurantId: null, unrestricted: true }, handler);
  },
};
