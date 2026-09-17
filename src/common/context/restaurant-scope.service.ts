import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RestaurantRouter } from './restaurant-router.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly router: RestaurantRouter,
  ) {}

  /** Établissement courant, ou `null` pour un compte non cloisonné. */
  current(): string | null {
    return restaurantContext.activeRestaurantId();
  }

  /**
   * L'établissement dont la carte est servie au client.
   *
   * **Le plus proche de lui**, et non plus le plus ancien.
   *
   * Un client n'appartient à aucun établissement — il commande où il
   * veut — mais l'enseigne en compte plusieurs, et il faut bien en
   * désigner un : celui dont il voit la carte, les prix, les frais de
   * livraison, et surtout celui dont la cuisine recevra sa commande.
   * Tant que c'était le **plus ancien**, quelqu'un habitant à côté de
   * Kipé commandait à Kaloum, à vingt kilomètres, et son plat partait de
   * là-bas.
   *
   * La position vient de son adresse enregistrée, pas de son téléphone :
   * on sert la maison proche de l'endroit où le repas doit arriver, pas
   * de celui d'où l'on commande. Voir [[RestaurantRouter.forCustomer]].
   *
   * Le repli — aucune adresse, aucune coordonnée, visite anonyme —
   * reste la maison la plus ancienne. Il faut bien servir une carte à
   * quelqu'un qu'on ne sait pas situer.
   *
   * C'est ici, et nulle part ailleurs, que se décide quel établissement
   * le public voit : [[SettingsService.getRestaurant]] s'y réfère pour
   * que la fiche et la carte ne puissent pas désigner deux maisons.
   */
  async publicRestaurantId(): Promise<string> {
    const scope = restaurantContext.current();
    if (!scope) return this.oldestId();

    /*
     * Trois sources, par ordre de confiance décroissant, résolues une
     * seule fois pour toute la requête :
     *
     *  1. **La position que l'application désigne** — l'adresse choisie à
     *     l'écran, ou le GPS. C'est ce que le client regarde ; le carnet
     *     ne le sait pas.
     *  2. **Son adresse par défaut**, quand l'application n'a rien dit.
     *  3. **La maison la plus ancienne**, quand rien ne permet de le
     *     situer.
     *
     * Le premier échelon manquait. Un client qui choisissait son adresse
     * de Kipé lisait « Kipé » à l'écran et recevait la carte de Kaloum —
     * puis se faisait refuser à la commande, sans pouvoir comprendre.
     */
    scope.servedBy ??= this.resolveServedBy(scope).catch(() => this.oldestId());
    return scope.servedBy;
  }

  private async resolveServedBy(scope: NonNullable<ReturnType<typeof restaurantContext.current>>): Promise<string> {
    if (scope.position) {
      const proche = await this.router.nearestTo(scope.position);
      if (proche) return proche;
    }

    if (scope.customerId) {
      const proche = await this.router.forCustomer(scope.customerId);
      if (proche) return proche;
    }

    return this.oldestId();
  }

  /**
   * La maison la plus ancienne.
   *
   * Mémo de processus : elle ne change pas, et une lecture par requête
   * pour un identifiant immuable serait du gaspillage. Ouvrir une
   * seconde maison ne change pas laquelle est la plus ancienne.
   */
  private async oldestId(): Promise<string> {
    this.publicId ??= this.prisma.restaurant
      .findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } })
      .then((restaurant) => {
        if (restaurant) return restaurant.id;

        // Le mémo ne doit pas garder un échec : la base sera peut-être
        // peuplée dans la minute qui suit.
        this.publicId = null;
        throw AppException.notFound(
          "Le restaurant n'est pas configuré. Exécutez le seed avant de démarrer.",
        );
      })
      .catch((error: unknown) => {
        this.publicId = null;
        throw error;
      });

    return this.publicId;
  }

  private publicId: Promise<string> | null = null;

  /**
   * L'établissement dont la requête courante parle, en lecture.
   *
   * Un compte cloisonné parle du sien : c'est ce que [[current]] rend, et
   * c'est ce que le client Prisma applique déjà aux modèles cloisonnés.
   * Tous les autres — un client, une route publique, le propriétaire en
   * vue d'ensemble, une tâche hors requête — parlent de l'établissement
   * servi au public.
   *
   * Sans ce repli, les réglages du restaurant se lisaient toujours sur le
   * **plus ancien** : un ADMIN de la seconde maison voyait, et modifiait,
   * les horaires et les frais de livraison de la première.
   */
  async restaurantForRequest(): Promise<string> {
    return this.current() ?? this.publicRestaurantId();
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
