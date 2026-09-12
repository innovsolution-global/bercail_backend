import { DeliveryStatus, OrderStatus } from '@prisma/client';
import { assertNotDriverOwned } from './order-status';

/**
 * Frontière entre le back-office et le livreur.
 *
 * Tant que personne ne porte la commande, le restaurant pilote tout. Dès
 * qu'un livreur l'a prise, la suite raconte ce qu'il fait sur le terrain —
 * et le back-office n'a plus à l'écrire à sa place.
 *
 * L'enjeu n'est pas cosmétique : « livrée » déclenche l'encaissement du
 * paiement à la livraison. Marquer une commande livrée depuis un bureau,
 * c'est déclarer reçu un argent que personne n'a pris.
 */
describe('Ce qui appartient au livreur', () => {
  const enCours = { driverId: 'drv-1', status: DeliveryStatus.PICKED_UP };
  const sansLivreur = { driverId: null, status: DeliveryStatus.ASSIGNED };

  it('refuse au back-office de marquer une commande livrée', () => {
    // Le message ne parle plus de code : la remise se valide d'un geste,
    // depuis l'application du livreur.
    expect(() => assertNotDriverOwned(OrderStatus.DELIVERED, enCours)).toThrow(
      /validée par le livreur/i,
    );
  });

  it('refuse aussi de la déclarer en cours de livraison', () => {
    expect(() => assertNotDriverOwned(OrderStatus.OUT_FOR_DELIVERY, enCours)).toThrow(
      /son application/i,
    );
  });

  it('laisse passer tant qu’aucun livreur n’est attribué', () => {
    // Un retrait sur place n'a pas de livreur : le restaurant reste maître
    // de sa commande de bout en bout.
    expect(() => assertNotDriverOwned(OrderStatus.DELIVERED, sansLivreur)).not.toThrow();
    expect(() => assertNotDriverOwned(OrderStatus.DELIVERED, null)).not.toThrow();
  });

  it('rend la main quand la course a échoué', () => {
    // Le livreur n'a pas pu livrer : quelqu'un doit pouvoir reprendre la
    // commande, sinon elle reste bloquée pour toujours.
    const echouee = { driverId: 'drv-1', status: DeliveryStatus.FAILED };
    expect(() => assertNotDriverOwned(OrderStatus.DELIVERED, echouee)).not.toThrow();
  });

  it('ne bloque jamais les étapes de cuisine ni l’annulation', () => {
    // Détacher le livreur — repasser « prête » — reste la porte de sortie
    // quand un téléphone tombe en panne.
    for (const cible of [
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.CANCELLED,
    ]) {
      expect(() => assertNotDriverOwned(cible, enCours)).not.toThrow();
    }
  });
});
