import { DeliveryStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { DeliveriesService } from './deliveries.service';

/**
 * La position du livreur, vue du client.
 *
 * Relue toutes les cinq secondes pendant la course : c'est elle qui fait
 * bouger la moto sur le plan. Elle ne doit servir qu'au client de la
 * commande, et seulement tant que le livreur roule vers lui.
 */
describe('La position du livreur, vue du client', () => {
  const client = { id: 'u1', role: Role.CUSTOMER } as unknown as AuthenticatedUser;
  const autreClient = { id: 'u2', role: Role.CUSTOMER } as unknown as AuthenticatedUser;

  function monter(
    status: DeliveryStatus,
    position: { lastLatitude: number | null; lastLongitude: number | null } = {
      lastLatitude: 9.6,
      lastLongitude: -13.62,
    },
  ) {
    const commande = {
      id: 'o1',
      customerId: 'u1',
      delivery: {
        id: 'd1',
        status,
        driverId: 'dp1',
        estimatedArrivalAt: null,
        driver: { ...position, lastPositionAt: new Date('2026-09-14T18:00:00Z') },
      },
    };
    const prisma = { order: { findFirst: jest.fn(async () => commande) } };

    return new DeliveriesService(
      prisma as never,
      {} as never, // orders
      {} as never, // assignment
      {} as never, // notifications
      {} as never, // realtime
      {} as never, // audit
      {} as never, // settings
    );
  }

  it('le client lit la position de sa commande en route', async () => {
    const position = await monter(DeliveryStatus.IN_TRANSIT).locationForOrder(client, 'o1');

    expect(position).toMatchObject({
      latitude: 9.6,
      longitude: -13.62,
      updatedAt: '2026-09-14T18:00:00.000Z',
    });
  });

  it('un autre client ne la lit pas', async () => {
    await expect(
      monter(DeliveryStatus.IN_TRANSIT).locationForOrder(autreClient, 'o1'),
    ).rejects.toBeDefined();
  });

  it('plus rien une fois la commande livrée', async () => {
    expect(await monter(DeliveryStatus.DELIVERED).locationForOrder(client, 'o1')).toBeNull();
  });

  it('rien tant que le livreur n’a transmis aucune position', async () => {
    const position = await monter(DeliveryStatus.PICKED_UP, {
      lastLatitude: null,
      lastLongitude: null,
    }).locationForOrder(client, 'o1');

    expect(position).toBeNull();
  });
});
