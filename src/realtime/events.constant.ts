/**
 * Événements temps réel.
 *
 * Un seul catalogue, partagé par le backend, l'application Flutter et le
 * back-office React. Les noms suivent `domaine.action` et ne changent
 * jamais sans montée de version de l'API.
 */
export const REALTIME_EVENTS = {
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_STATUS_UPDATED: 'order.status.updated',

  DELIVERY_ASSIGNED: 'delivery.assigned',
  DELIVERY_STATUS_UPDATED: 'delivery.status.updated',

  DRIVER_LOCATION_UPDATED: 'driver.location.updated',
  DRIVER_STATUS_UPDATED: 'driver.status.updated',

  PAYMENT_UPDATED: 'payment.updated',

  NOTIFICATION_CREATED: 'notification.created',

  SYSTEM_ALERT: 'system.alert',
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

/** Salons. Un client n'entre que dans les salons que son rôle autorise. */
export const ROOMS = {
  user: (userId: string) => `user:${userId}`,
  role: (role: string) => `role:${role}`,
  /** Salon d'exploitation : ADMIN et SUPER_ADMIN y reçoivent les commandes. */
  backOffice: () => 'back-office',
  driver: (driverProfileId: string) => `driver:${driverProfileId}`,
  /** Suivi d'une commande précise (client, livreur assigné, back-office). */
  order: (orderId: string) => `order:${orderId}`,
} as const;
