import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { distanceMeters, isValidCoordinates, type Coordinates } from '../utils/geo.util';

/** Un établissement, réduit à ce qu'il faut pour choisir lequel sert. */
type Maison = {
  id: string;
  latitude: number;
  longitude: number;
  createdAt: Date;
};

/**
 * Quel établissement sert quel client.
 *
 * ## Le défaut que ceci corrige
 *
 * Toutes les commandes partaient au **même** établissement — le plus
 * ancien — quelle que soit la position du client, et l'alerte « nouvelle
 * commande » était envoyée à **tous** les gérants de l'enseigne. Deux
 * cuisines pouvaient donc préparer le même plat, et deux livreurs partir
 * pour la même adresse. C'est exactement ce qu'une enseigne à plusieurs
 * adresses ne doit jamais faire.
 *
 * La règle est maintenant la distance : un client est servi par la maison
 * **la plus proche de lui**. Elle décide de tout ce qui suit — la carte
 * qu'il voit, les prix qu'il paie, la cuisine qui reçoit sa commande et
 * le livreur qui part.
 *
 * ## Pourquoi la position vient de l'adresse, et non du téléphone
 *
 * Le GPS dit où le client **est** ; l'adresse dit où il veut être
 * **livré**. Quelqu'un qui commande depuis son bureau pour son domicile
 * doit être servi par la maison proche de son domicile — c'est là que le
 * repas doit arriver chaud. On lit donc son adresse par défaut, celle
 * que l'application propose déjà au paiement.
 *
 * Sans adresse ni coordonnées — un client qui n'a rien enregistré, une
 * visite anonyme — on retombe sur la maison la plus ancienne. C'est le
 * comportement d'avant, et il reste juste : il faut bien servir une
 * carte à quelqu'un dont on ignore où il se trouve.
 */
@Injectable()
export class RestaurantRouter {
  private readonly logger = new Logger(RestaurantRouter.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Durée de vie du mémo de la liste des établissements. */
  private static readonly TTL_MS = 60_000;

  private maisons: Maison[] | null = null;
  private expireAt = 0;

  /**
   * Les établissements ouverts au public, avec leurs coordonnées.
   *
   * Mémorisés une minute : la table compte quelques lignes et ne change
   * qu'à l'ouverture d'une adresse, mais elle est lue à chaque requête
   * publique. Une minute suffit à ce qu'une nouvelle maison entre en
   * service sans redémarrage.
   */
  private async open(): Promise<Maison[]> {
    if (this.maisons && Date.now() < this.expireAt) return this.maisons;

    const rows = await this.prisma.restaurant.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, latitude: true, longitude: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    this.maisons = rows;
    this.expireAt = Date.now() + RestaurantRouter.TTL_MS;
    return rows;
  }

  /** Oublie le mémo — après l'ouverture ou la fermeture d'une adresse. */
  forget(): void {
    this.maisons = null;
    this.expireAt = 0;
  }

  /** La maison la plus ancienne : le repli, quand on ne sait pas situer. */
  async oldest(): Promise<string | null> {
    const maisons = await this.open();
    return maisons[0]?.id ?? null;
  }

  /** Toutes les maisons ouvertes au public, de la plus ancienne à la plus récente. */
  async activeIds(): Promise<string[]> {
    return (await this.open()).map((maison) => maison.id);
  }

  /**
   * Les maisons situables, de la plus proche à la plus lointaine d'un point.
   *
   * C'est l'ordre dans lequel une commande cherche une cuisine de secours
   * quand la plus proche n'a plus l'un des plats : voir [[KitchenSelector]].
   * Vide si le point est inutilisable.
   */
  async closestFirst(position: Coordinates): Promise<string[]> {
    if (!isValidCoordinates(position)) return [];

    return (await this.open())
      .filter((m) => isValidCoordinates({ latitude: m.latitude, longitude: m.longitude }))
      .map((maison) => ({ id: maison.id, distance: distanceMeters(position, maison) }))
      .sort((left, right) => left.distance - right.distance)
      .map((maison) => maison.id);
  }

  /**
   * La maison la plus proche d'un point.
   *
   * `null` si le point est inutilisable ou si aucune maison n'a de
   * coordonnées : l'appelant retombe alors sur [[oldest]] plutôt que de
   * désigner une maison au hasard.
   */
  async nearestTo(position: Coordinates): Promise<string | null> {
    if (!isValidCoordinates(position)) return null;

    const maisons = (await this.open()).filter((m) =>
      isValidCoordinates({ latitude: m.latitude, longitude: m.longitude }),
    );
    if (maisons.length === 0) return null;

    let choisie = maisons[0];
    let plusCourte = distanceMeters(position, choisie);

    for (const maison of maisons.slice(1)) {
      const distance = distanceMeters(position, maison);
      if (distance < plusCourte) {
        plusCourte = distance;
        choisie = maison;
      }
    }

    return choisie.id;
  }

  /**
   * La maison qui sert ce client.
   *
   * Son adresse par défaut d'abord — c'est celle que l'application
   * propose au paiement, donc celle où le repas ira le plus souvent.
   * À défaut, la dernière adresse qu'il a enregistrée avec un point.
   *
   * `null` quand rien ne permet de le situer : aucune adresse, ou aucune
   * adresse localisée. Le client reste alors servi par la maison la plus
   * ancienne — et c'est une raison de plus pour que le formulaire
   * d'adresse propose la position.
   */
  async forCustomer(userId: string): Promise<string | null> {
    const adresses = await this.prisma.address.findMany({
      where: {
        userId,
        deletedAt: null,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: { latitude: true, longitude: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      take: 1,
    });

    const adresse = adresses[0];
    if (!adresse || adresse.latitude === null || adresse.longitude === null) {
      return null;
    }

    return this.nearestTo({ latitude: adresse.latitude, longitude: adresse.longitude });
  }

}
