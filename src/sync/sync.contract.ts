import { SyncNode, SyncOperation } from '@prisma/client';

/**
 * Contrat de synchronisation entre le serveur du restaurant et celui en
 * ligne.
 *
 * Une écriture voyage telle qu'elle a été faite : l'entité, son
 * identifiant, l'opération et la ligne complète. Le récepteur n'a rien à
 * deviner de ce qui a changé.
 */
export interface SyncChange {
  /** Identifiant de l'écriture chez l'émetteur : c'est la clé d'idempotence. */
  id: string;
  origin: SyncNode;
  entity: string;
  entityId: string;
  operation: SyncOperation;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface SyncPushRequest {
  node: SyncNode;
  changes: SyncChange[];
}

export interface SyncPushResponse {
  /** Écritures acceptées, y compris celles déjà connues d'un envoi précédent. */
  accepted: string[];
  /** Écritures mises de côté, avec le motif : elles attendent une décision. */
  conflicted: { id: string; reason: string }[];
}

export interface SyncPullResponse {
  changes: SyncChange[];
  /** Horodatage de la dernière écriture du lot : curseur de la prochaine lecture. */
  cursor: string | null;
  /** Vrai s'il reste des écritures au-delà de ce lot. */
  hasMore: boolean;
}

/**
 * Qui a le droit d'écrire quoi.
 *
 * C'est la règle qui rend la synchronisation sûre : la plupart des données
 * n'ont **qu'un seul écrivain**, et là où il n'y en a qu'un, il n'y a rien
 * à arbitrer.
 *
 *  • `LOCAL`  — saisi dans le restaurant : la carte, le stock, les achats,
 *    les dépenses, la paie. Le serveur en ligne les reçoit sans jamais les
 *    modifier.
 *  • `CLOUD`  — vit en ligne : les adresses des clients, les livraisons et
 *    la position des livreurs en course.
 *  • `SHARED` — écrit des deux côtés. Une commande naît au comptoir ou dans
 *    l'application ; un compte est créé par un client en ligne ou par un
 *    gérant sur place. Ces cas sont rares et traités explicitement.
 */
export type Ownership = SyncNode | 'SHARED';

export const ENTITY_OWNERSHIP: Readonly<Record<string, Ownership>> = {
  // Exploitation — écrite sur place.
  MenuItem: SyncNode.LOCAL,
  Category: SyncNode.LOCAL,
  MenuOptionGroup: SyncNode.LOCAL,
  MenuOption: SyncNode.LOCAL,
  RecipeIngredient: SyncNode.LOCAL,
  StockItem: SyncNode.LOCAL,
  StockMovement: SyncNode.LOCAL,
  Supplier: SyncNode.LOCAL,
  Purchase: SyncNode.LOCAL,
  PurchaseItem: SyncNode.LOCAL,
  Expense: SyncNode.LOCAL,
  Income: SyncNode.LOCAL,
  Employee: SyncNode.LOCAL,
  Promotion: SyncNode.LOCAL,
  Restaurant: SyncNode.LOCAL,
  OpeningHour: SyncNode.LOCAL,
  SystemSettings: SyncNode.LOCAL,
  Permission: SyncNode.LOCAL,
  RolePermission: SyncNode.LOCAL,
  UserPermission: SyncNode.LOCAL,

  // Clientèle et livraison — vivent en ligne.
  CustomerProfile: SyncNode.CLOUD,
  DriverProfile: SyncNode.CLOUD,
  Address: SyncNode.CLOUD,
  Delivery: SyncNode.CLOUD,
  DeliveryEvent: SyncNode.CLOUD,

  // Écrits des deux côtés.
  //
  // `User` en fait partie : un client s'inscrit en ligne, un livreur ou un
  // administrateur est créé depuis le back-office, sur place.
  User: 'SHARED',
  Order: 'SHARED',
  OrderItem: 'SHARED',
  OrderItemOption: 'SHARED',
  OrderStatusHistory: 'SHARED',
  Payment: 'SHARED',
  PaymentEvent: 'SHARED',
  CouponUsage: 'SHARED',
};

/**
 * Table Prisma correspondant à chaque entité.
 *
 * Écrite à la main plutôt que déduite du nom : une entité oubliée doit se
 * voir au démarrage, pas produire une écriture silencieusement perdue.
 */
export const ENTITY_MODELS: Readonly<Record<string, string>> = {
  MenuItem: 'menuItem',
  Category: 'category',
  MenuOptionGroup: 'menuOptionGroup',
  MenuOption: 'menuOption',
  RecipeIngredient: 'recipeIngredient',
  StockItem: 'stockItem',
  StockMovement: 'stockMovement',
  Supplier: 'supplier',
  Purchase: 'purchase',
  PurchaseItem: 'purchaseItem',
  Expense: 'expense',
  Income: 'income',
  Employee: 'employee',
  Promotion: 'promotion',
  Restaurant: 'restaurant',
  OpeningHour: 'openingHour',
  SystemSettings: 'systemSettings',
  Permission: 'permission',
  RolePermission: 'rolePermission',
  UserPermission: 'userPermission',
  User: 'user',
  CustomerProfile: 'customerProfile',
  DriverProfile: 'driverProfile',
  Address: 'address',
  Delivery: 'delivery',
  DeliveryEvent: 'deliveryEvent',
  Order: 'order',
  OrderItem: 'orderItem',
  OrderItemOption: 'orderItemOption',
  OrderStatusHistory: 'orderStatusHistory',
  Payment: 'payment',
  PaymentEvent: 'paymentEvent',
  CouponUsage: 'couponUsage',
};

/**
 * Entités écrites en ajout seul.
 *
 * Elles ne se modifient jamais : une ligne d'historique existe ou n'existe
 * pas. Les deux serveurs peuvent donc y écrire sans jamais se contredire —
 * c'est ce qui permet à la cuisine de faire avancer une commande passée
 * depuis l'application, pendant que le client la suit en ligne.
 */
export const APPEND_ONLY_ENTITIES: ReadonlySet<string> = new Set([
  'OrderStatusHistory',
  'PaymentEvent',
  'DeliveryEvent',
  'StockMovement',
  'CouponUsage',
]);

/**
 * Ordre d'application d'un lot.
 *
 * Une ligne de commande ne peut pas s'écrire avant sa commande, ni un achat
 * avant son fournisseur. Le rang donne l'ordre des dépendances ; à rang
 * égal, l'horodatage tranche.
 */
const ENTITY_RANK: Readonly<Record<string, number>> = {
  Permission: 0,
  Restaurant: 0,
  Category: 0,
  Supplier: 0,
  User: 0,
  SystemSettings: 0,

  RolePermission: 1,
  UserPermission: 1,
  OpeningHour: 1,
  MenuItem: 1,
  StockItem: 1,
  Employee: 1,
  Promotion: 1,
  CustomerProfile: 1,
  DriverProfile: 1,
  Address: 1,

  MenuOptionGroup: 2,
  Purchase: 2,
  Order: 2,

  MenuOption: 3,
  RecipeIngredient: 3,
  PurchaseItem: 3,
  Expense: 3,
  Income: 3,
  StockMovement: 3,
  OrderItem: 3,
  Payment: 3,
  Delivery: 3,
  OrderStatusHistory: 3,
  CouponUsage: 3,

  OrderItemOption: 4,
  PaymentEvent: 4,
  DeliveryEvent: 4,
};

export function entityRank(entity: string): number {
  return ENTITY_RANK[entity] ?? 5;
}

/** Trie un lot par dépendances, puis par horodatage. */
export function orderChanges(changes: SyncChange[]): SyncChange[] {
  return [...changes].sort((left, right) => {
    const rank = entityRank(left.entity) - entityRank(right.entity);
    if (rank !== 0) return rank;
    return left.occurredAt.localeCompare(right.occurredAt);
  });
}

export function isSynchronised(entity: string): boolean {
  return entity in ENTITY_OWNERSHIP;
}

/** L'autre nœud. */
export function peerOf(node: SyncNode): SyncNode {
  return node === SyncNode.LOCAL ? SyncNode.CLOUD : SyncNode.LOCAL;
}
