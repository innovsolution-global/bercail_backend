import { OrderStatus, OrderType, Role } from '@prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import {
  CUSTOMER_CANCELLABLE,
  allowedTargetsForRole,
  assertTransition,
  canTransition,
} from './order-status';

/**
 * La machine à états est la garantie qu'aucun frontend ne peut « poser »
 * un statut arbitraire. Ces tests décrivent le contrat métier, pas
 * l'implémentation.
 */
describe('Machine à états des commandes', () => {
  describe('progression nominale', () => {
    const timeline: [OrderStatus, OrderStatus][] = [
      [OrderStatus.PENDING, OrderStatus.CONFIRMED],
      [OrderStatus.CONFIRMED, OrderStatus.PREPARING],
      [OrderStatus.PREPARING, OrderStatus.READY],
      [OrderStatus.READY, OrderStatus.ASSIGNED],
      [OrderStatus.ASSIGNED, OrderStatus.OUT_FOR_DELIVERY],
      [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
    ];

    it.each(timeline)('autorise %s → %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to, OrderType.DELIVERY)).not.toThrow();
    });
  });

  describe('transitions refusées', () => {
    it('refuse de sauter la préparation', () => {
      expect(canTransition(OrderStatus.PENDING, OrderStatus.DELIVERED)).toBe(false);
      expect(() =>
        assertTransition(OrderStatus.PENDING, OrderStatus.DELIVERED, OrderType.DELIVERY),
      ).toThrow(AppException);
    });

    it('refuse de revenir en arrière', () => {
      expect(canTransition(OrderStatus.DELIVERED, OrderStatus.PREPARING)).toBe(false);
    });

    it('refuse toute transition depuis un statut terminal', () => {
      expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toBe(false);
      expect(canTransition(OrderStatus.CANCELLED, OrderStatus.CONFIRMED)).toBe(false);
    });

    it('signale explicitement une commande déjà dans le statut demandé', () => {
      expect(() =>
        assertTransition(OrderStatus.PREPARING, OrderStatus.PREPARING, OrderType.DELIVERY),
      ).toThrow(/déjà en préparation/);
    });
  });

  describe('règles propres au mode de retrait', () => {
    it('interdit de livrer une commande DELIVERY sans passer par un livreur', () => {
      expect(() =>
        assertTransition(OrderStatus.READY, OrderStatus.DELIVERED, OrderType.DELIVERY),
      ).toThrow(/attribuée à un livreur/);
    });

    it('autorise une commande PICKUP à passer de prête à livrée', () => {
      expect(() =>
        assertTransition(OrderStatus.READY, OrderStatus.DELIVERED, OrderType.PICKUP),
      ).not.toThrow();
    });

    it("refuse d'assigner un livreur à une commande à emporter", () => {
      expect(() =>
        assertTransition(OrderStatus.READY, OrderStatus.ASSIGNED, OrderType.PICKUP),
      ).toThrow(/ne se livre pas/);
    });
  });

  describe('annulation', () => {
    it('est possible tant que la commande n’est pas livrée', () => {
      for (const status of [
        OrderStatus.PENDING,
        OrderStatus.CONFIRMED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.ASSIGNED,
        OrderStatus.OUT_FOR_DELIVERY,
      ]) {
        expect(canTransition(status, OrderStatus.CANCELLED)).toBe(true);
      }
    });

    it('n’est ouverte au client que sur les deux premiers statuts', () => {
      expect(CUSTOMER_CANCELLABLE).toEqual([OrderStatus.PENDING, OrderStatus.CONFIRMED]);

      expect(allowedTargetsForRole(Role.CUSTOMER, OrderStatus.PENDING)).toEqual([
        OrderStatus.CANCELLED,
      ]);
      expect(allowedTargetsForRole(Role.CUSTOMER, OrderStatus.PREPARING)).toEqual([]);
    });
  });

  describe('périmètre par rôle', () => {
    it("n'accorde aucune transition de commande au livreur", () => {
      // Le livreur pilote sa livraison ; c'est le service de livraison qui
      // répercute sur la commande.
      expect(allowedTargetsForRole(Role.DRIVER, OrderStatus.READY)).toEqual([]);
    });

    it('laisse au back-office toutes les transitions valides', () => {
      expect(allowedTargetsForRole(Role.ADMIN, OrderStatus.PENDING)).toEqual([
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
      ]);
    });
  });
});
