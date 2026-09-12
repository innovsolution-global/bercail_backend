import { OrderStatus, OrderType } from '@prisma/client';
import { assertTransition } from '../orders/order-status';

/**
 * Qui peut recevoir un livreur.
 *
 * Une commande prise au restaurant — emportée ou consommée sur place — n'a
 * pas de course : le client est déjà là. Lui attribuer un livreur créerait
 * une livraison fantôme, occuperait quelqu'un qui a mieux à faire, et
 * ferait apparaître la commande dans le suivi des courses alors qu'elle
 * n'en est pas une.
 *
 * Le refus vit à deux endroits, et ce n'est pas une duplication : la
 * machine à états garde les transitions de la commande, `DeliveriesService`
 * garde la création de la course. On peut demander l'une sans l'autre, donc
 * chacune se défend seule.
 */
describe('Éligibilité à une attribution', () => {
  it('accepte une commande en livraison', () => {
    expect(() =>
      assertTransition(OrderStatus.READY, OrderStatus.ASSIGNED, OrderType.DELIVERY),
    ).not.toThrow();
  });

  it('refuse une commande à emporter', () => {
    expect(() =>
      assertTransition(OrderStatus.READY, OrderStatus.ASSIGNED, OrderType.PICKUP),
    ).toThrow(/à emporter ne se livre pas/i);
  });

  it('refuse une commande servie sur place, et le dit sans se tromper', () => {
    // Le message compte : annoncer « à emporter » à quelqu'un qui regarde
    // une commande consommée sur place le fait douter de ce que le
    // logiciel a compris de sa commande.
    expect(() =>
      assertTransition(OrderStatus.READY, OrderStatus.ASSIGNED, OrderType.DINE_IN),
    ).toThrow(/servie sur place ne se livre pas/i);
  });

  it('refuse aussi de les déclarer en cours de livraison', () => {
    for (const type of [OrderType.PICKUP, OrderType.DINE_IN]) {
      expect(() =>
        assertTransition(OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY, type),
      ).toThrow(/ne se livre pas/i);
    }
  });

  it('laisse le comptoir clore une commande prise au restaurant', () => {
    // Le pendant du refus : sans livreur, personne d'autre que le comptoir
    // ne peut fermer la commande.
    for (const type of [OrderType.PICKUP, OrderType.DINE_IN]) {
      expect(() =>
        assertTransition(OrderStatus.READY, OrderStatus.DELIVERED, type),
      ).not.toThrow();
    }
  });

  it('exige au contraire un livreur pour clore une livraison', () => {
    expect(() =>
      assertTransition(OrderStatus.READY, OrderStatus.DELIVERED, OrderType.DELIVERY),
    ).toThrow(/attribuée à un livreur/i);
  });
});
