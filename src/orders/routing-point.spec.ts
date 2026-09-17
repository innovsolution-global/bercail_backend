import { RestaurantRouter } from '../common/context/restaurant-router.service';
import type { PrismaService } from '../database/prisma.service';
import { deliveryPoint, routingPoint } from './routing-point';

/**
 * La maison qui reçoit une commande.
 *
 * Le calcul lui-même est simple — la plus proche du point livré. Ce qui
 * peut le fausser, ce sont ses entrées : le point retenu pour la commande,
 * et la position enregistrée de chaque maison.
 */
describe('La maison qui reçoit une commande', () => {
  const BUREAU_KALOUM = { latitude: 9.5092, longitude: -13.7122 };
  const DOMICILE_KIPE = { latitude: 9.6385, longitude: -13.6215 };

  it('livre là où le client est, pas à l’adresse qu’il a enregistrée', () => {
    // Adresse enregistrée au bureau, à Kaloum ; commande passée de chez
    // soi, à Kipé : le repas va à Kipé.
    expect(deliveryPoint(DOMICILE_KIPE, BUREAU_KALOUM)).toEqual(DOMICILE_KIPE);
  });

  it('retombe sur la position de l’adresse quand la commande n’en donne pas', () => {
    expect(deliveryPoint(null, BUREAU_KALOUM)).toEqual(BUREAU_KALOUM);
    expect(deliveryPoint({ latitude: null, longitude: null }, BUREAU_KALOUM)).toEqual(BUREAU_KALOUM);
    // Ni l'une ni l'autre : rien.
    expect(deliveryPoint(null, { latitude: null, longitude: null })).toBeNull();
  });

  it('part du point de livraison, pas de l’endroit d’où l’on lit la carte', () => {
    expect(routingPoint(DOMICILE_KIPE, BUREAU_KALOUM)).toEqual(DOMICILE_KIPE);
  });

  it('retombe sur la position désignée par l’application sans point de livraison', () => {
    expect(routingPoint(null, BUREAU_KALOUM)).toEqual(BUREAU_KALOUM);
  });

  it('ne désigne rien quand rien ne situe la commande', () => {
    expect(routingPoint(null, null)).toBeNull();
    // Un point à moitié renseigné ne situe rien non plus.
    expect(routingPoint({ latitude: 9.6, longitude: null }, undefined)).toBeNull();
  });

  it('une maison mal placée capte les commandes de ses voisines', async () => {
    // Ce qui s'est produit : « Matoto » enregistrée aux coordonnées
    // génériques de Conakry, en plein Kaloum. Un client de Gbessia, à
    // Matoto, partait alors chez Kipé.
    const KIPE = { id: 'kipe', latitude: 9.639167, longitude: -13.622222 };
    const monter = (matoto: { latitude: number; longitude: number }) =>
      new RestaurantRouter({
        restaurant: {
          findMany: jest.fn(async () =>
            [KIPE, { id: 'matoto', ...matoto }].map((m) => ({ ...m, createdAt: new Date() })),
          ),
        },
      } as unknown as PrismaService);

    const GBESSIA = { latitude: 9.577, longitude: -13.612 };

    expect(await monter({ latitude: 9.509167, longitude: -13.712222 }).nearestTo(GBESSIA)).toBe('kipe');
    expect(await monter({ latitude: 9.5767, longitude: -13.619 }).nearestTo(GBESSIA)).toBe('matoto');
  });
});
