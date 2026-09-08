/**
 * Catalogue des permissions — source de vérité du RBAC.
 *
 * Ce fichier est volontairement sans dépendance (ni Prisma, ni Nest) :
 * il est consommé par les guards, par le seed, par l'endpoint qui
 * alimente l'écran « Permissions » du back-office React, et par les tests.
 *
 * Les codes correspondent exactement au catalogue attendu par le
 * front-office d'administration (`src/types/permissions.ts`).
 */

export const PERMISSION_MODULES = [
  'users',
  'customers',
  'drivers',
  'menu',
  'orders',
  'payments',
  'deliveries',
  'promotions',
  'stock',
  'finance',
  'hr',
  'reports',
  'settings',
  'audit',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const PERMISSIONS = [
  // Administrateurs (réservé au SUPER_ADMIN)
  'USERS_READ',
  'USERS_CREATE',
  'USERS_UPDATE',
  'USERS_DELETE',
  'USERS_SUSPEND',
  'USERS_PERMISSIONS',

  // Clients
  'CUSTOMERS_READ',
  'CUSTOMERS_UPDATE',
  'CUSTOMERS_SUSPEND',
  'CUSTOMERS_EXPORT',

  // Livreurs
  'DRIVERS_READ',
  'DRIVERS_CREATE',
  'DRIVERS_UPDATE',
  'DRIVERS_SUSPEND',
  'DRIVERS_DELETE',

  // Carte
  'MENU_READ',
  'MENU_CREATE',
  'MENU_UPDATE',
  'MENU_DELETE',
  'MENU_AVAILABILITY',
  'CATEGORIES_MANAGE',

  // Commandes
  'ORDERS_READ',
  'ORDERS_UPDATE_STATUS',
  'ORDERS_ASSIGN_DRIVER',
  'ORDERS_CANCEL',
  'ORDERS_EXPORT',
  'POS_SELL',

  // Paiements
  'PAYMENTS_READ',
  'PAYMENTS_REFUND',
  'PAYMENTS_EXPORT',

  // Livraisons
  'DELIVERIES_READ',
  'DELIVERIES_UPDATE',
  'DELIVERIES_TRACK',

  // Promotions
  'PROMOTIONS_READ',
  'PROMOTIONS_CREATE',
  'PROMOTIONS_UPDATE',
  'PROMOTIONS_DELETE',

  // Stock et approvisionnement
  'STOCK_READ',
  'STOCK_MANAGE',
  'PURCHASES_MANAGE',
  'SUPPLIERS_MANAGE',

  // Finances
  'FINANCE_READ',
  'FINANCE_EXPORT',
  'EXPENSES_MANAGE',
  'INCOMES_MANAGE',

  // Personnel
  'EMPLOYEES_READ',
  'EMPLOYEES_MANAGE',
  'PAYROLL_MANAGE',

  // Rapports
  'REPORTS_READ',
  'REPORTS_EXPORT',

  // Paramètres
  'SETTINGS_READ',
  'SETTINGS_UPDATE',
  'SETTINGS_SYSTEM',

  // Journaux d'audit
  'AUDIT_READ',
  'AUDIT_EXPORT',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionDefinition {
  code: Permission;
  module: PermissionModule;
  label: string;
  /** Une action sensible est systématiquement auditée. */
  sensitive: boolean;
  description: string;
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  {
    code: 'USERS_READ',
    module: 'users',
    label: 'Consulter les administrateurs',
    sensitive: false,
    description: 'Voir la liste et les fiches des comptes du back-office.',
  },
  {
    code: 'USERS_CREATE',
    module: 'users',
    label: 'Créer un administrateur',
    sensitive: true,
    description: "Créer un compte ADMIN et déclencher son lien d'activation.",
  },
  {
    code: 'USERS_UPDATE',
    module: 'users',
    label: 'Modifier un administrateur',
    sensitive: true,
    description: "Modifier l'identité et les coordonnées d'un compte du back-office.",
  },
  {
    code: 'USERS_DELETE',
    module: 'users',
    label: 'Supprimer un administrateur',
    sensitive: true,
    description: 'Désactiver définitivement un compte du back-office (suppression logique).',
  },
  {
    code: 'USERS_SUSPEND',
    module: 'users',
    label: 'Suspendre un administrateur',
    sensitive: true,
    description: "Suspendre ou réactiver l'accès d'un compte du back-office.",
  },
  {
    code: 'USERS_PERMISSIONS',
    module: 'users',
    label: 'Gérer les permissions',
    sensitive: true,
    description: "Attribuer ou retirer les permissions d'un ADMIN.",
  },

  {
    code: 'CUSTOMERS_READ',
    module: 'customers',
    label: 'Consulter les clients',
    sensitive: false,
    description: 'Voir la liste, les fiches et l’historique des clients.',
  },
  {
    code: 'CUSTOMERS_UPDATE',
    module: 'customers',
    label: 'Modifier un client',
    sensitive: false,
    description: 'Corriger les coordonnées d’un client.',
  },
  {
    code: 'CUSTOMERS_SUSPEND',
    module: 'customers',
    label: 'Suspendre un client',
    sensitive: true,
    description: 'Suspendre ou réactiver un compte client.',
  },
  {
    code: 'CUSTOMERS_EXPORT',
    module: 'customers',
    label: 'Exporter les clients',
    sensitive: false,
    description: 'Générer un export de la base clients.',
  },

  {
    code: 'DRIVERS_READ',
    module: 'drivers',
    label: 'Consulter les livreurs',
    sensitive: false,
    description: 'Voir les livreurs, leur disponibilité et leurs statistiques.',
  },
  {
    code: 'DRIVERS_CREATE',
    module: 'drivers',
    label: 'Créer un livreur',
    sensitive: true,
    description: "Créer un compte livreur et générer ses identifiants d'activation.",
  },
  {
    code: 'DRIVERS_UPDATE',
    module: 'drivers',
    label: 'Modifier un livreur',
    sensitive: false,
    description: 'Modifier la fiche, le véhicule ou la zone d’un livreur.',
  },
  {
    code: 'DRIVERS_SUSPEND',
    module: 'drivers',
    label: 'Suspendre un livreur',
    sensitive: true,
    description: 'Suspendre ou réactiver un compte livreur.',
  },
  {
    code: 'DRIVERS_DELETE',
    module: 'drivers',
    label: 'Supprimer un livreur',
    sensitive: true,
    description: 'Supprimer logiquement un compte livreur.',
  },

  {
    code: 'MENU_READ',
    module: 'menu',
    label: 'Consulter la carte',
    sensitive: false,
    description: 'Voir les produits, catégories et options.',
  },
  {
    code: 'MENU_CREATE',
    module: 'menu',
    label: 'Créer un produit',
    sensitive: false,
    description: 'Ajouter un plat à la carte.',
  },
  {
    code: 'MENU_UPDATE',
    module: 'menu',
    label: 'Modifier un produit',
    sensitive: true,
    description: 'Modifier un plat, y compris son prix (action auditée).',
  },
  {
    code: 'MENU_DELETE',
    module: 'menu',
    label: 'Supprimer un produit',
    sensitive: true,
    description: 'Retirer un plat de la carte (suppression logique).',
  },
  {
    code: 'MENU_AVAILABILITY',
    module: 'menu',
    label: 'Gérer la disponibilité',
    sensitive: false,
    description: 'Marquer un plat disponible ou en rupture.',
  },
  {
    code: 'CATEGORIES_MANAGE',
    module: 'menu',
    label: 'Gérer les catégories',
    sensitive: false,
    description: 'Créer, modifier, réordonner et supprimer les catégories.',
  },

  {
    code: 'ORDERS_READ',
    module: 'orders',
    label: 'Consulter les commandes',
    sensitive: false,
    description: 'Voir les commandes, leur détail et leur historique.',
  },
  {
    code: 'ORDERS_UPDATE_STATUS',
    module: 'orders',
    label: 'Faire avancer une commande',
    sensitive: false,
    description: 'Confirmer, préparer, marquer prête une commande.',
  },
  {
    code: 'ORDERS_ASSIGN_DRIVER',
    module: 'orders',
    label: 'Attribuer un livreur',
    sensitive: true,
    description: 'Assigner ou réassigner une commande à un livreur.',
  },
  {
    code: 'ORDERS_CANCEL',
    module: 'orders',
    label: 'Annuler une commande',
    sensitive: true,
    description: 'Annuler une commande (action auditée).',
  },
  {
    code: 'ORDERS_EXPORT',
    module: 'orders',
    label: 'Exporter les commandes',
    sensitive: false,
    description: 'Générer un export des commandes.',
  },
  {
    code: 'POS_SELL',
    module: 'orders',
    label: 'Encaisser au comptoir',
    sensitive: false,
    description: 'Saisir et encaisser une commande prise sur place, sans passer par l’application.',
  },

  {
    code: 'PAYMENTS_READ',
    module: 'payments',
    label: 'Consulter les paiements',
    sensitive: false,
    description: 'Voir les transactions et leur statut.',
  },
  {
    code: 'PAYMENTS_REFUND',
    module: 'payments',
    label: 'Rembourser',
    sensitive: true,
    description: 'Déclencher le remboursement d’un paiement (action auditée).',
  },
  {
    code: 'PAYMENTS_EXPORT',
    module: 'payments',
    label: 'Exporter les paiements',
    sensitive: false,
    description: 'Générer un export comptable des paiements.',
  },

  {
    code: 'DELIVERIES_READ',
    module: 'deliveries',
    label: 'Consulter les livraisons',
    sensitive: false,
    description: 'Voir les courses en cours et terminées.',
  },
  {
    code: 'DELIVERIES_UPDATE',
    module: 'deliveries',
    label: 'Intervenir sur une livraison',
    sensitive: true,
    description: 'Corriger le statut d’une livraison depuis le back-office.',
  },
  {
    code: 'DELIVERIES_TRACK',
    module: 'deliveries',
    label: 'Suivre en temps réel',
    sensitive: false,
    description: 'Consulter la position des livreurs en course.',
  },

  {
    code: 'PROMOTIONS_READ',
    module: 'promotions',
    label: 'Consulter les promotions',
    sensitive: false,
    description: 'Voir les promotions et leur utilisation.',
  },
  {
    code: 'PROMOTIONS_CREATE',
    module: 'promotions',
    label: 'Créer une promotion',
    sensitive: false,
    description: 'Créer un code promotionnel.',
  },
  {
    code: 'PROMOTIONS_UPDATE',
    module: 'promotions',
    label: 'Modifier une promotion',
    sensitive: true,
    description: 'Modifier ou activer/désactiver une promotion.',
  },
  {
    code: 'PROMOTIONS_DELETE',
    module: 'promotions',
    label: 'Supprimer une promotion',
    sensitive: true,
    description: 'Supprimer logiquement une promotion.',
  },

  {
    code: 'STOCK_READ',
    module: 'stock',
    label: 'Consulter le stock',
    sensitive: false,
    description: 'Voir les articles, les quantités disponibles et le journal des mouvements.',
  },
  {
    code: 'STOCK_MANAGE',
    module: 'stock',
    label: 'Gérer le stock',
    sensitive: false,
    description: 'Créer des articles et enregistrer entrées, sorties de cuisine et pertes.',
  },
  {
    code: 'PURCHASES_MANAGE',
    module: 'stock',
    label: 'Enregistrer les achats',
    sensitive: true,
    description: 'Saisir un approvisionnement : il entre en stock et crée la dépense.',
  },
  {
    code: 'SUPPLIERS_MANAGE',
    module: 'stock',
    label: 'Gérer les fournisseurs',
    sensitive: false,
    description: 'Créer, modifier et désactiver les fournisseurs du restaurant.',
  },

  {
    code: 'FINANCE_READ',
    module: 'finance',
    label: 'Consulter les finances',
    sensitive: false,
    description: 'Voir le journal de caisse, les dépenses, les recettes et le résultat.',
  },
  {
    code: 'FINANCE_EXPORT',
    module: 'finance',
    label: 'Exporter les finances',
    sensitive: false,
    description: 'Télécharger le journal et le rapport d’activité mensuel.',
  },
  {
    code: 'EXPENSES_MANAGE',
    module: 'finance',
    label: 'Gérer les dépenses',
    sensitive: true,
    description: 'Enregistrer, régler et annuler une charge (action auditée).',
  },
  {
    code: 'INCOMES_MANAGE',
    module: 'finance',
    label: 'Gérer les recettes diverses',
    sensitive: true,
    description: 'Enregistrer une entrée d’argent hors vente (action auditée).',
  },

  {
    code: 'EMPLOYEES_READ',
    module: 'hr',
    label: 'Consulter le personnel',
    sensitive: false,
    description: 'Voir les fiches des employés et leur historique de paie.',
  },
  {
    code: 'EMPLOYEES_MANAGE',
    module: 'hr',
    label: 'Gérer le personnel',
    sensitive: true,
    description: 'Créer, modifier et sortir un employé des effectifs.',
  },
  {
    code: 'PAYROLL_MANAGE',
    module: 'hr',
    label: 'Gérer la paie',
    sensitive: true,
    description: 'Générer et régler les salaires du mois (action auditée).',
  },

  {
    code: 'REPORTS_READ',
    module: 'reports',
    label: 'Consulter les rapports',
    sensitive: false,
    description: 'Accéder au tableau de bord et aux rapports.',
  },
  {
    code: 'REPORTS_EXPORT',
    module: 'reports',
    label: 'Exporter les rapports',
    sensitive: false,
    description: 'Télécharger les rapports générés par le serveur.',
  },

  {
    code: 'SETTINGS_READ',
    module: 'settings',
    label: 'Consulter les paramètres',
    sensitive: false,
    description: 'Voir la fiche restaurant et les paramètres opérationnels.',
  },
  {
    code: 'SETTINGS_UPDATE',
    module: 'settings',
    label: 'Modifier les paramètres',
    sensitive: true,
    description: 'Modifier horaires, frais de livraison et seuils (action auditée).',
  },
  {
    code: 'SETTINGS_SYSTEM',
    module: 'settings',
    label: 'Paramètres système',
    sensitive: true,
    description: 'Modifier les paramètres système et de sécurité (SUPER_ADMIN).',
  },

  {
    code: 'AUDIT_READ',
    module: 'audit',
    label: "Consulter le journal d'audit",
    sensitive: false,
    description: 'Lire les journaux des actions sensibles.',
  },
  {
    code: 'AUDIT_EXPORT',
    module: 'audit',
    label: "Exporter le journal d'audit",
    sensitive: false,
    description: 'Télécharger le journal des actions sensibles.',
  },
];

export const SENSITIVE_PERMISSIONS: readonly Permission[] = PERMISSION_CATALOG.filter(
  (definition) => definition.sensitive,
).map((definition) => definition.code);

/**
 * Socle de permissions attaché à chaque rôle.
 *
 * CUSTOMER et DRIVER n'ont aucune permission : leurs accès sont décidés par
 * les règles d'appartenance (ownership), jamais par une permission globale.
 * Le SUPER_ADMIN possède toutes les permissions, sans exception.
 */
export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  CUSTOMER: [],
  DRIVER: [],
  ADMIN: [
    'CUSTOMERS_READ',
    'CUSTOMERS_UPDATE',
    'CUSTOMERS_SUSPEND',
    'CUSTOMERS_EXPORT',
    'DRIVERS_READ',
    'DRIVERS_CREATE',
    'DRIVERS_UPDATE',
    'DRIVERS_SUSPEND',
    'MENU_READ',
    'MENU_CREATE',
    'MENU_UPDATE',
    'MENU_DELETE',
    'MENU_AVAILABILITY',
    'CATEGORIES_MANAGE',
    'ORDERS_READ',
    'ORDERS_UPDATE_STATUS',
    'ORDERS_ASSIGN_DRIVER',
    'ORDERS_CANCEL',
    'ORDERS_EXPORT',
    'PAYMENTS_READ',
    'PAYMENTS_REFUND',
    'PAYMENTS_EXPORT',
    'DELIVERIES_READ',
    'DELIVERIES_UPDATE',
    'DELIVERIES_TRACK',
    'PROMOTIONS_READ',
    'PROMOTIONS_CREATE',
    'PROMOTIONS_UPDATE',
    'PROMOTIONS_DELETE',
    'POS_SELL',
    'STOCK_READ',
    'STOCK_MANAGE',
    'PURCHASES_MANAGE',
    'SUPPLIERS_MANAGE',
    'FINANCE_READ',
    'FINANCE_EXPORT',
    'EXPENSES_MANAGE',
    'INCOMES_MANAGE',
    'EMPLOYEES_READ',
    'REPORTS_READ',
    'REPORTS_EXPORT',
    'SETTINGS_READ',
    'SETTINGS_UPDATE',
  ],
  SUPER_ADMIN: [...PERMISSIONS],
};

/** Permissions qu'un SUPER_ADMIN ne peut jamais déléguer à un ADMIN. */
export const SUPER_ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  'USERS_READ',
  'USERS_CREATE',
  'USERS_UPDATE',
  'USERS_DELETE',
  'USERS_SUSPEND',
  'USERS_PERMISSIONS',
  'SETTINGS_SYSTEM',
];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
