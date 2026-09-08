import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';
import { REALTIME_EVENTS, ROOMS } from './events.constant';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Diffusion des événements métier.
 *
 * Les services métier appellent ce service, jamais la passerelle
 * directement : le choix des salons (qui a le droit de voir quoi) est
 * décidé ici, en un seul endroit.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  /**
   * Salons d'une commande. `customerId` est nul pour une vente au
   * comptoir : il n'y a alors personne à prévenir côté client.
   */
  private orderRooms(id: string, customerId: string | null | undefined): string[] {
    const rooms = [ROOMS.backOffice(), ROOMS.order(id)];
    if (customerId) rooms.push(ROOMS.user(customerId));
    return rooms;
  }

  private emit(rooms: string[], event: string, payload: unknown): void {
    try {
      this.gateway.emitToRooms(rooms, event, payload);
    } catch (error) {
      // Le temps réel est un confort : son échec ne remet jamais en cause
      // l'opération métier déjà validée en base.
      this.logger.warn(`Diffusion ${event} impossible : ${(error as Error).message}`);
    }
  }

  /** Nouvelle commande : le back-office doit la voir apparaître seul. */
  orderCreated(payload: {
    id: string;
    customerId: string | null;
    reference: string;
    [key: string]: unknown;
  }): void {
    this.emit(
      this.orderRooms(payload.id, payload.customerId),
      REALTIME_EVENTS.ORDER_CREATED,
      payload,
    );
  }

  orderUpdated(payload: { id: string; customerId: string | null; [key: string]: unknown }): void {
    this.emit(
      this.orderRooms(payload.id, payload.customerId),
      REALTIME_EVENTS.ORDER_UPDATED,
      payload,
    );
  }

  orderStatusUpdated(payload: {
    id: string;
    customerId: string | null;
    status: string;
    driverProfileId?: string | null;
    [key: string]: unknown;
  }): void {
    const rooms = this.orderRooms(payload.id, payload.customerId);
    if (payload.driverProfileId) rooms.push(ROOMS.driver(payload.driverProfileId));
    this.emit(rooms, REALTIME_EVENTS.ORDER_STATUS_UPDATED, payload);
  }

  /** Nouvelle course : seul le livreur concerné la reçoit. */
  deliveryAssigned(payload: {
    id: string;
    orderId: string;
    driverProfileId: string;
    customerId: string | null;
    [key: string]: unknown;
  }): void {
    this.emit(
      [ROOMS.driver(payload.driverProfileId), ...this.orderRooms(payload.orderId, payload.customerId)],
      REALTIME_EVENTS.DELIVERY_ASSIGNED,
      payload,
    );
  }

  deliveryStatusUpdated(payload: {
    id: string;
    orderId: string;
    status: string;
    customerId: string | null;
    driverProfileId?: string | null;
    [key: string]: unknown;
  }): void {
    const rooms = this.orderRooms(payload.orderId, payload.customerId);
    if (payload.driverProfileId) rooms.push(ROOMS.driver(payload.driverProfileId));
    this.emit(rooms, REALTIME_EVENTS.DELIVERY_STATUS_UPDATED, payload);
  }

  /**
   * Position du livreur.
   *
   * Diffusée au salon de la commande : le client suit sa livraison, le
   * back-office suit la flotte. Un client sans commande active ne reçoit
   * rien, parce qu'il n'est dans aucun de ces salons.
   */
  driverLocationUpdated(payload: {
    driverProfileId: string;
    orderId?: string | null;
    latitude: number;
    longitude: number;
    heading?: number | null;
    speed?: number | null;
    recordedAt: string;
  }): void {
    const rooms = [ROOMS.backOffice()];
    if (payload.orderId) rooms.push(ROOMS.order(payload.orderId));
    this.emit(rooms, REALTIME_EVENTS.DRIVER_LOCATION_UPDATED, payload);
  }

  driverStatusUpdated(payload: {
    driverProfileId: string;
    isOnline: boolean;
    isAvailable: boolean;
  }): void {
    this.emit([ROOMS.backOffice()], REALTIME_EVENTS.DRIVER_STATUS_UPDATED, payload);
  }

  paymentUpdated(payload: {
    id: string;
    orderId: string;
    customerId: string | null;
    status: string;
    [key: string]: unknown;
  }): void {
    this.emit(
      this.orderRooms(payload.orderId, payload.customerId),
      REALTIME_EVENTS.PAYMENT_UPDATED,
      payload,
    );
  }

  notificationCreated(userId: string, payload: unknown): void {
    this.emit([ROOMS.user(userId)], REALTIME_EVENTS.NOTIFICATION_CREATED, payload);
  }

  notifyRole(role: Role, event: string, payload: unknown): void {
    this.emit([ROOMS.role(role)], event, payload);
  }

  systemAlert(payload: unknown): void {
    this.gateway.broadcastSystemAlert(payload);
  }
}
