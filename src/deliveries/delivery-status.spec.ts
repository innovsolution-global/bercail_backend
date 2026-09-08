import { DeliveryStatus } from '@prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import {
  DELIVERY_ACTIVE,
  assertDeliveryTransition,
  canTransitionDelivery,
  timestampField,
} from './delivery-status';

describe('Machine à états des livraisons', () => {
  it('suit le trajet réel du livreur', () => {
    const journey: [DeliveryStatus, DeliveryStatus][] = [
      [DeliveryStatus.ASSIGNED, DeliveryStatus.ACCEPTED],
      [DeliveryStatus.ACCEPTED, DeliveryStatus.ARRIVED_AT_RESTAURANT],
      [DeliveryStatus.ARRIVED_AT_RESTAURANT, DeliveryStatus.PICKED_UP],
      [DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT],
      [DeliveryStatus.IN_TRANSIT, DeliveryStatus.ARRIVED_AT_CUSTOMER],
      [DeliveryStatus.ARRIVED_AT_CUSTOMER, DeliveryStatus.DELIVERED],
    ];

    for (const [from, to] of journey) {
      expect(canTransitionDelivery(from, to)).toBe(true);
    }
  });

  it('tolère les raccourcis du terrain', () => {
    // Livreur déjà sur place : accepter puis récupérer directement.
    expect(canTransitionDelivery(DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP)).toBe(true);
    // Trajet court : récupérer puis arriver.
    expect(
      canTransitionDelivery(DeliveryStatus.PICKED_UP, DeliveryStatus.ARRIVED_AT_CUSTOMER),
    ).toBe(true);
  });

  it('interdit de livrer sans avoir récupéré la commande', () => {
    expect(canTransitionDelivery(DeliveryStatus.ASSIGNED, DeliveryStatus.DELIVERED)).toBe(false);
    expect(() =>
      assertDeliveryTransition(DeliveryStatus.ASSIGNED, DeliveryStatus.DELIVERED),
    ).toThrow(AppException);
  });

  it('rend les statuts terminaux définitifs', () => {
    expect(canTransitionDelivery(DeliveryStatus.DELIVERED, DeliveryStatus.IN_TRANSIT)).toBe(false);
    expect(canTransitionDelivery(DeliveryStatus.FAILED, DeliveryStatus.ACCEPTED)).toBe(false);
  });

  it('permet de déclarer un échec à toute étape active', () => {
    for (const status of DELIVERY_ACTIVE) {
      expect(canTransitionDelivery(status, DeliveryStatus.FAILED)).toBe(true);
    }
  });

  it('associe un horodatage à chaque étape', () => {
    expect(timestampField(DeliveryStatus.ACCEPTED)).toBe('acceptedAt');
    expect(timestampField(DeliveryStatus.PICKED_UP)).toBe('pickedUpAt');
    expect(timestampField(DeliveryStatus.DELIVERED)).toBe('deliveredAt');
    expect(timestampField(DeliveryStatus.ASSIGNED)).toBeNull();
  });

  it('considère le livreur mobilisé tant que la course n’est pas terminée', () => {
    expect(DELIVERY_ACTIVE).not.toContain(DeliveryStatus.DELIVERED);
    expect(DELIVERY_ACTIVE).not.toContain(DeliveryStatus.FAILED);
    expect(DELIVERY_ACTIVE).toContain(DeliveryStatus.ASSIGNED);
    expect(DELIVERY_ACTIVE).toContain(DeliveryStatus.IN_TRANSIT);
  });
});
