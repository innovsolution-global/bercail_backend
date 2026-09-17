/**
 * Jeu de données de démonstration — LE BERCAIL.
 *
 * Il produit un restaurant complet et cohérent : carte, clients, livreurs,
 * administrateurs, commandes à tous les stades du cycle de vie, paiements,
 * livraisons, promotions et notifications. De quoi brancher les deux
 * frontends sur des données réalistes dès la première minute.
 *
 * Le seed est idempotent : il vide les tables métier avant de réécrire,
 * et refuse de s'exécuter en production.
 *
 * Identifiants de test : voir la table affichée en fin d'exécution, et
 * docs/README. Ils ne doivent JAMAIS être utilisés en production.
 */
import {
  AccountStatus,
  AlertSeverity,
  ContractType,
  DeliveryStatus,
  EmployeeStatus,
  ExpenseCategory,
  ExpenseStatus,
  FinancePaymentMethod,
  IncomeCategory,
  NotificationType,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  PromotionType,
  Role,
  StockCategory,
  StockMovementReason,
  StockMovementType,
  StockUnit,
  VehicleType,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomInt } from 'node:crypto';
import {
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
} from '../src/common/constants/permissions.constant';

const prisma = new PrismaClient();

/* ────────────────────────────── Utilitaires ─────────────────────────────── */

const PASSWORDS = {
  superAdmin: process.env.SUPER_ADMIN_PASSWORD ?? 'SuperAdmin@2024',
  /**
   * Gérant du premier établissement. Le seed ne crée que celui-là ; les
   * établissements suivants sont ajoutés depuis le back-office, et leurs
   * gérants aussi. `npm run admins:verify` contrôle que les accès notés
   * dans `.env` fonctionnent encore, quel que soit leur origine.
   */
  admin: process.env.ADMIN_BRC_PASSWORD ?? 'Admin@2024',
  driver: 'Livreur@2024',
  customer: 'Client@2024',
};

function hash(value: string): string {
  return bcrypt.hashSync(value, 10);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function daysAgo(days: number, hour = 12): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, randomInt(0, 60), 0, 0);
  return date;
}

function minutesAfter(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length)];
}

function reference(index: number, date: Date): string {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 3; i += 1) suffix += alphabet[randomInt(0, alphabet.length)];
  return `BRC-${year}${month}${day}-${suffix}${index % 10}`;
}

/* ─────────────────────────────── Données ────────────────────────────────── */

const CATEGORIES = [
  { name: 'Grillades', emoji: '🔥', description: 'Viandes et poulets braisés au feu de bois.' },
  { name: 'Poissons', emoji: '🐟', description: 'Pêche du jour de Conakry.' },
  { name: 'Plats guinéens', emoji: '🍲', description: 'Les classiques de la maison.' },
  { name: 'Riz & Accompagnements', emoji: '🍚', description: 'Riz gras, attiéké, alloco.' },
  { name: 'Entrées', emoji: '🥗', description: 'Salades et petites entrées.' },
  { name: 'Desserts', emoji: '🍮', description: 'Douceurs maison.' },
  { name: 'Boissons', emoji: '🥤', description: 'Jus locaux, sodas et eaux.' },
];

const MENU_ITEMS: {
  category: string;
  name: string;
  shortDescription: string;
  price: number;
  promoPrice?: number;
  popular?: boolean;
  suggestion?: boolean;
  spicy?: boolean;
  prep?: number;
  ingredients: string[];
}[] = [
  // Grillades
  { category: 'Grillades', name: 'Poulet braisé entier', shortDescription: 'Mariné 12 h, sauce maison', price: 145000, popular: true, prep: 35, ingredients: ['Poulet fermier', 'Ail', 'Gingembre', 'Piment doux'] },
  { category: 'Grillades', name: 'Demi-poulet braisé', shortDescription: 'La portion des gourmands', price: 80000, popular: true, prep: 30, ingredients: ['Poulet fermier', 'Ail', 'Gingembre'] },
  { category: 'Grillades', name: 'Brochettes de bœuf', shortDescription: 'Trois brochettes, sauce arachide', price: 65000, spicy: true, prep: 25, ingredients: ['Bœuf', 'Oignon', 'Poivron', 'Arachide'] },
  { category: 'Grillades', name: 'Côtelettes d’agneau', shortDescription: 'Grillées au charbon', price: 125000, suggestion: true, prep: 30, ingredients: ['Agneau', 'Romarin', 'Ail'] },
  { category: 'Grillades', name: 'Poulet yassa', shortDescription: 'Oignons confits au citron', price: 90000, popular: true, prep: 30, ingredients: ['Poulet', 'Oignon', 'Citron', 'Moutarde'] },
  { category: 'Grillades', name: 'Merguez maison', shortDescription: 'Épicée, préparée sur place', price: 55000, spicy: true, prep: 20, ingredients: ['Bœuf', 'Épices', 'Piment'] },

  // Poissons
  { category: 'Poissons', name: 'Capitaine braisé', shortDescription: 'Poisson entier, sauce verte', price: 155000, popular: true, prep: 35, ingredients: ['Capitaine', 'Persil', 'Citron', 'Oignon'] },
  { category: 'Poissons', name: 'Bar grillé', shortDescription: 'Pêche du jour', price: 135000, suggestion: true, prep: 30, ingredients: ['Bar', 'Herbes fraîches'] },
  { category: 'Poissons', name: 'Crevettes sautées', shortDescription: 'Ail et persil', price: 120000, prep: 20, ingredients: ['Crevettes', 'Ail', 'Persil', 'Beurre'] },
  { category: 'Poissons', name: 'Sole meunière', shortDescription: 'Beurre citronné', price: 110000, prep: 25, ingredients: ['Sole', 'Beurre', 'Citron'] },
  { category: 'Poissons', name: 'Poisson fumé sauce tomate', shortDescription: 'Recette de la maison', price: 95000, prep: 30, ingredients: ['Poisson fumé', 'Tomate', 'Oignon'] },

  // Plats guinéens
  { category: 'Plats guinéens', name: 'Sauce feuille', shortDescription: 'Feuilles de patate, viande fumée', price: 70000, popular: true, prep: 25, ingredients: ['Feuilles de patate', 'Viande fumée', 'Huile de palme'] },
  { category: 'Plats guinéens', name: 'Sauce arachide', shortDescription: 'Onctueuse, servie avec riz', price: 72000, prep: 25, ingredients: ['Arachide', 'Viande', 'Tomate'] },
  { category: 'Plats guinéens', name: 'Fouti (riz sauce)', shortDescription: 'Le plat du dimanche', price: 68000, prep: 30, ingredients: ['Riz', 'Sauce tomate', 'Viande'] },
  { category: 'Plats guinéens', name: 'Konkoé à l’huile de palme', shortDescription: 'Spécialité côtière', price: 98000, spicy: true, prep: 35, ingredients: ['Konkoé', 'Huile de palme', 'Piment'] },
  { category: 'Plats guinéens', name: 'Mafé de bœuf', shortDescription: 'Mijoté lentement', price: 85000, prep: 35, ingredients: ['Bœuf', 'Arachide', 'Carotte'] },
  { category: 'Plats guinéens', name: 'Poulet DG', shortDescription: 'Plantain, légumes croquants', price: 105000, suggestion: true, prep: 30, ingredients: ['Poulet', 'Plantain', 'Poivron', 'Carotte'] },

  // Riz & accompagnements
  { category: 'Riz & Accompagnements', name: 'Riz gras', shortDescription: 'Cuisiné au bouillon', price: 35000, prep: 15, ingredients: ['Riz', 'Tomate', 'Bouillon'] },
  { category: 'Riz & Accompagnements', name: 'Attiéké', shortDescription: 'Semoule de manioc', price: 30000, prep: 10, ingredients: ['Manioc'] },
  { category: 'Riz & Accompagnements', name: 'Alloco', shortDescription: 'Bananes plantains frites', price: 28000, popular: true, prep: 12, ingredients: ['Plantain', 'Huile'] },
  { category: 'Riz & Accompagnements', name: 'Frites maison', shortDescription: 'Pommes de terre fraîches', price: 30000, prep: 12, ingredients: ['Pomme de terre'] },
  { category: 'Riz & Accompagnements', name: 'Foutou banane', shortDescription: 'Pilé à la main', price: 38000, prep: 20, ingredients: ['Banane plantain'] },
  { category: 'Riz & Accompagnements', name: 'Salade d’accompagnement', shortDescription: 'Crudités du marché', price: 25000, prep: 8, ingredients: ['Laitue', 'Tomate', 'Concombre'] },

  // Entrées
  { category: 'Entrées', name: 'Salade César', shortDescription: 'Poulet grillé, parmesan', price: 55000, prep: 12, ingredients: ['Laitue', 'Poulet', 'Parmesan', 'Croûtons'] },
  { category: 'Entrées', name: 'Avocat crevettes', shortDescription: 'Sauce cocktail', price: 60000, prep: 10, ingredients: ['Avocat', 'Crevettes'] },
  { category: 'Entrées', name: 'Soupe de poisson', shortDescription: 'Bouillon parfumé', price: 45000, prep: 15, ingredients: ['Poisson', 'Tomate', 'Épices'] },
  { category: 'Entrées', name: 'Accras de morue', shortDescription: 'Six pièces, sauce piquante', price: 40000, spicy: true, prep: 15, ingredients: ['Morue', 'Farine', 'Piment'] },
  { category: 'Entrées', name: 'Samoussas viande', shortDescription: 'Quatre pièces', price: 35000, prep: 12, ingredients: ['Viande', 'Pâte', 'Épices'] },

  // Desserts
  { category: 'Desserts', name: 'Salade de fruits', shortDescription: 'Fruits de saison', price: 30000, prep: 8, ingredients: ['Mangue', 'Ananas', 'Papaye'] },
  { category: 'Desserts', name: 'Beignets sucrés', shortDescription: 'Servis tièdes', price: 25000, prep: 10, ingredients: ['Farine', 'Sucre'] },
  { category: 'Desserts', name: 'Gâteau au chocolat', shortDescription: 'Cœur fondant', price: 40000, suggestion: true, prep: 10, ingredients: ['Chocolat', 'Œuf', 'Farine'] },
  { category: 'Desserts', name: 'Glace artisanale', shortDescription: 'Deux boules au choix', price: 28000, prep: 5, ingredients: ['Lait', 'Sucre'] },

  // Boissons
  { category: 'Boissons', name: 'Jus de gingembre', shortDescription: 'Fait maison, bien frais', price: 20000, popular: true, prep: 3, ingredients: ['Gingembre', 'Citron'] },
  { category: 'Boissons', name: 'Jus de bissap', shortDescription: 'Hibiscus infusé', price: 20000, prep: 3, ingredients: ['Hibiscus', 'Menthe'] },
  { category: 'Boissons', name: 'Eau minérale 1,5 L', shortDescription: 'Bouteille', price: 12000, prep: 1, ingredients: ['Eau'] },
  { category: 'Boissons', name: 'Soda 33 cl', shortDescription: 'Au choix', price: 15000, prep: 1, ingredients: [] },
  { category: 'Boissons', name: 'Café touba', shortDescription: 'Épicé, servi chaud', price: 15000, prep: 5, ingredients: ['Café', 'Poivre de Guinée'] },
];

const CUSTOMERS = [
  { firstName: 'Mariama', lastName: 'Diallo', email: 'mariama.diallo@example.gn', phone: '+224620112201', district: 'Kaloum', street: 'Rue KA 021' },
  { firstName: 'Ibrahima', lastName: 'Barry', email: 'ibrahima.barry@example.gn', phone: '+224620112202', district: 'Dixinn', street: 'Avenue de la République' },
  { firstName: 'Fatoumata', lastName: 'Camara', email: 'fatoumata.camara@example.gn', phone: '+224620112203', district: 'Ratoma', street: 'Cité de l’Air, villa 12' },
  { firstName: 'Ousmane', lastName: 'Sylla', email: 'ousmane.sylla@example.gn', phone: '+224620112204', district: 'Matam', street: 'Rue MA 45' },
  { firstName: 'Aissatou', lastName: 'Bah', email: 'aissatou.bah@example.gn', phone: '+224620112205', district: 'Ratoma', street: 'Kipé, carrefour Constantin' },
  { firstName: 'Mamadou', lastName: 'Keita', email: 'mamadou.keita@example.gn', phone: '+224620112206', district: 'Matoto', street: 'Route Le Prince' },
  { firstName: 'Kadiatou', lastName: 'Touré', email: 'kadiatou.toure@example.gn', phone: '+224620112207', district: 'Dixinn', street: 'Belle-Vue, rue 3' },
  { firstName: 'Sekou', lastName: 'Conde', email: 'sekou.conde@example.gn', phone: '+224620112208', district: 'Kaloum', street: 'Boulbinet, rue du port' },
  { firstName: 'Hadja', lastName: 'Soumah', email: 'hadja.soumah@example.gn', phone: '+224620112209', district: 'Ratoma', street: 'Nongo, résidence Les Palmiers' },
  { firstName: 'Alpha', lastName: 'Balde', email: 'alpha.balde@example.gn', phone: '+224620112210', district: 'Matoto', street: 'Gbessia, près de l’aéroport' },
];

const DRIVERS = [
  { firstName: 'Ibrahima', lastName: 'Camara', email: 'ibrahima.camara@lebercail.gn', phone: '+224620330001', zone: 'Kaloum', vehicle: VehicleType.MOTO, plate: 'RC-2451-A' },
  { firstName: 'Moussa', lastName: 'Bangoura', email: 'moussa.bangoura@lebercail.gn', phone: '+224620330002', zone: 'Dixinn', vehicle: VehicleType.MOTO, plate: 'RC-3312-B' },
  { firstName: 'Aboubacar', lastName: 'Diallo', email: 'aboubacar.diallo@lebercail.gn', phone: '+224620330003', zone: 'Ratoma', vehicle: VehicleType.SCOOTER, plate: 'RC-7788-C' },
  { firstName: 'Lansana', lastName: 'Kourouma', email: 'lansana.kourouma@lebercail.gn', phone: '+224620330004', zone: 'Matam', vehicle: VehicleType.MOTO, plate: 'RC-1290-D' },
  { firstName: 'Thierno', lastName: 'Sow', email: 'thierno.sow@lebercail.gn', phone: '+224620330005', zone: 'Matoto', vehicle: VehicleType.VOITURE, plate: 'RC-9001-E' },
];

/* ──────────────────────────────── Seed ──────────────────────────────────── */

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Le seed de démonstration est interdit en production.');
  }

  console.log('🌱 Seed LE BERCAIL — démarrage');

  await truncate();
  await seedPermissions();

  const restaurant = await seedRestaurant();
  const { categories, menuItems } = await seedMenu();
  const { superAdmin, admins } = await seedStaff(restaurant.id);
  const drivers = await seedDrivers(superAdmin.id, restaurant.id);
  const customers = await seedCustomers();
  const promotions = await seedPromotions();

  await seedOrders({ restaurant, menuItems, customers, drivers, admins, promotions });
  await seedPosOrders({ restaurant, menuItems, cashierId: admins[0]?.id ?? superAdmin.id });
  const operations = await seedOperations(superAdmin.id, restaurant.id);
  await seedRecipes(menuItems, operations.stockItems);
  await seedNotifications(customers, admins, superAdmin);
  await seedSecurityAlerts();

  console.log('\n✅ Seed terminé.\n');
  await printSummary();
}

async function truncate(): Promise<void> {
  // L'ordre suit les dépendances : les enfants d'abord.
  await prisma.$transaction([
    prisma.recipeIngredient.deleteMany(),
    prisma.stockMovement.deleteMany(),
    prisma.purchaseItem.deleteMany(),
    prisma.expense.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.stockItem.deleteMany(),
    prisma.income.deleteMany(),
    prisma.employee.deleteMany(),
    prisma.supplier.deleteMany(),
    prisma.deliveryVerificationCode.deleteMany(),
    prisma.driverLocation.deleteMany(),
    prisma.deliveryEvent.deleteMany(),
    prisma.delivery.deleteMany(),
    prisma.paymentEvent.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.orderItemOption.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.orderStatusHistory.deleteMany(),
    prisma.couponUsage.deleteMany(),
    prisma.order.deleteMany(),
    prisma.cartItemOption.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    prisma.favorite.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.deviceToken.deleteMany(),
    prisma.address.deleteMany(),
    prisma.menuOption.deleteMany(),
    prisma.menuOptionGroup.deleteMany(),
    prisma.menuItemStockout.deleteMany(),
    prisma.menuItem.deleteMany(),
    prisma.category.deleteMany(),
    prisma.promotion.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.securityAlert.deleteMany(),
    prisma.idempotencyKey.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.authToken.deleteMany(),
    prisma.userPermission.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.driverProfile.deleteMany(),
    prisma.customerProfile.deleteMany(),
    prisma.user.deleteMany(),
    prisma.openingHour.deleteMany(),
    prisma.restaurant.deleteMany(),
    prisma.systemSettings.deleteMany(),
  ]);

  console.log('   • Tables métier réinitialisées');
}

async function seedPermissions(): Promise<void> {
  await prisma.permission.createMany({
    data: PERMISSION_CATALOG.map((definition) => ({
      code: definition.code,
      module: definition.module,
      label: definition.label,
      description: definition.description,
      isSensitive: definition.sensitive,
    })),
  });

  const stored = await prisma.permission.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(stored.map((entry) => [entry.code, entry.id]));

  const rolePermissions: { role: Role; permissionId: string }[] = [];
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of permissions) {
      const permissionId = idByCode.get(code);
      if (permissionId) rolePermissions.push({ role: role as Role, permissionId });
    }
  }

  await prisma.rolePermission.createMany({ data: rolePermissions });
  console.log(`   • ${stored.length} permissions et ${rolePermissions.length} liaisons de rôle`);
}

async function seedRestaurant() {
  const restaurant = await prisma.restaurant.create({
    data: {
      code: 'BRC',
      name: 'Le Bercail',
      tagline: 'Les saveurs du Bercail',
      description:
        "Cuisine guinéenne et grillades au feu de bois, à Conakry. Sur place, à emporter ou livré chez vous.",
      phone: '+224620000000',
      email: 'contact@lebercail.gn',
      address: 'Corniche Sud, immeuble Kaloum',
      district: 'Kaloum',
      city: 'Conakry',
      latitude: 9.509167,
      longitude: -13.712222,
      isOpen: true,
      deliveryEnabled: true,
      pickupEnabled: true,
      deliveryFee: 15000,
      freeDeliveryThreshold: 300000,
      minimumOrderAmount: 50000,
      averagePreparationMinutes: 25,
      averageDeliveryMinutes: 30,
      deliveryZones: ['Kaloum', 'Dixinn', 'Ratoma', 'Matam', 'Matoto'],
      currency: 'GNF',
      openingHours: {
        create: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          opensAt: weekday === 7 ? '11:00' : '10:00',
          closesAt: weekday >= 5 ? '23:59' : '23:00',
          isClosed: false,
        })),
      },
    },
  });

  await prisma.systemSettings.create({ data: { id: 'system' } });

  console.log('   • Restaurant et paramètres système');
  return restaurant;
}

async function seedMenu() {
  const categories = await Promise.all(
    CATEGORIES.map((category, index) =>
      prisma.category.create({
        data: {
          name: category.name,
          slug: category.name
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, ''),
          emoji: category.emoji,
          description: category.description,
          sortOrder: index,
          isActive: true,
        },
      }),
    ),
  );

  const categoryByName = new Map(categories.map((category) => [category.name, category]));
  const menuItems = [];

  for (const item of MENU_ITEMS) {
    const category = categoryByName.get(item.category)!;
    const isDish = !['Boissons', 'Desserts'].includes(item.category);

    const created = await prisma.menuItem.create({
      data: {
        categoryId: category.id,
        name: item.name,
        shortDescription: item.shortDescription,
        description: `${item.name} — ${item.shortDescription}. Préparé à la commande dans les cuisines du Bercail.`,
        price: item.price,
        promoPrice: item.promoPrice ?? null,
        imageUrl: '',
        ingredients: item.ingredients,
        isAvailable: true,
        isPopular: item.popular ?? false,
        isSuggestion: item.suggestion ?? false,
        isSpicy: item.spicy ?? false,
        preparationMinutes: item.prep ?? 20,
        rating: Math.round((4 + Math.random()) * 10) / 10,
        reviewCount: randomInt(12, 340),
        ordersCount: randomInt(0, 180),
        // Les plats principaux proposent un accompagnement et une cuisson.
        optionGroups: isDish
          ? {
              create: [
                {
                  name: 'Accompagnement',
                  isRequired: true,
                  minSelect: 1,
                  maxSelect: 1,
                  sortOrder: 0,
                  options: {
                    create: [
                      { name: 'Riz gras', extraPrice: 0, sortOrder: 0 },
                      { name: 'Attiéké', extraPrice: 0, sortOrder: 1 },
                      { name: 'Alloco', extraPrice: 5000, sortOrder: 2 },
                      { name: 'Frites maison', extraPrice: 5000, sortOrder: 3 },
                      { name: 'Sans accompagnement', extraPrice: 0, sortOrder: 4 },
                    ],
                  },
                },
                {
                  name: 'Sauce',
                  isRequired: false,
                  minSelect: 0,
                  maxSelect: 2,
                  sortOrder: 1,
                  options: {
                    create: [
                      { name: 'Sauce piment', extraPrice: 0, sortOrder: 0 },
                      { name: 'Sauce arachide', extraPrice: 8000, sortOrder: 1 },
                      { name: 'Sauce verte', extraPrice: 8000, sortOrder: 2 },
                    ],
                  },
                },
              ],
            }
          : undefined,
      },
      include: { optionGroups: { include: { options: true } } },
    });

    menuItems.push(created);
  }

  console.log(`   • ${categories.length} catégories et ${menuItems.length} plats`);
  return { categories, menuItems };
}

async function seedStaff(restaurantId: string) {
  const superAdmin = await prisma.user.create({
    data: {
      restaurantId,
      firstName: 'Amadou',
      lastName: 'Bah',
      email: process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@lebercail.gn',
      phone: process.env.SUPER_ADMIN_PHONE ?? '+224620000001',
      passwordHash: hash(PASSWORDS.superAdmin),
      role: Role.SUPER_ADMIN,
      status: AccountStatus.ACTIVE,
      lastLoginAt: daysAgo(0, 8),
    },
  });

  // ADMIN 1 : gestion complète (socle du rôle).
  const admin1 = await prisma.user.create({
    data: {
      restaurantId,
      firstName: 'Fatoumata',
      lastName: 'Sylla',
      email: process.env.ADMIN_BRC_EMAIL ?? 'admin@lebercail.gn',
      phone: process.env.ADMIN_BRC_PHONE ?? '+224620000002',
      passwordHash: hash(PASSWORDS.admin),
      role: Role.ADMIN,
      status: AccountStatus.ACTIVE,
      createdById: superAdmin.id,
      lastLoginAt: daysAgo(0, 9),
    },
  });

  // ADMIN 2 : droits volontairement restreints — il illustre le RBAC fin.
  const admin2 = await prisma.user.create({
    data: {
      restaurantId,
      firstName: 'Mohamed',
      lastName: 'Doumbouya',
      email: 'admin.carte@lebercail.gn',
      phone: '+224620000003',
      passwordHash: hash(PASSWORDS.admin),
      role: Role.ADMIN,
      status: AccountStatus.ACTIVE,
      createdById: superAdmin.id,
      lastLoginAt: daysAgo(1, 15),
    },
  });

  const permissions = await prisma.permission.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(permissions.map((permission) => [permission.code, permission.id]));

  // Ce qu'on lui accorde en plus / retire du socle ADMIN.
  const allowedForAdmin2 = new Set([
    'MENU_READ',
    'MENU_CREATE',
    'MENU_UPDATE',
    'MENU_AVAILABILITY',
    'CATEGORIES_MANAGE',
    'ORDERS_READ',
    'REPORTS_READ',
  ]);

  const socle = new Set<string>(ROLE_PERMISSIONS.ADMIN ?? []);

  // Retirés : ce que le socle donne et qui ne lui est pas accordé.
  const retires = [...socle]
    .filter((code) => !allowedForAdmin2.has(code))
    .map((code) => ({ userId: admin2.id, permissionId: idByCode.get(code)!, granted: false }));

  // Accordés : ce qui lui est donné hors du socle. L'écriture de la carte
  // n'est plus dans le socle ADMIN depuis que la carte est commune ; sans
  // cette ligne, ce compte « carte » perdrait justement la carte.
  const accordes = [...allowedForAdmin2]
    .filter((code) => !socle.has(code))
    .map((code) => ({ userId: admin2.id, permissionId: idByCode.get(code)!, granted: true }));

  const overrides = [...retires, ...accordes].filter((entry) => Boolean(entry.permissionId));

  await prisma.userPermission.createMany({ data: overrides });

  console.log('   • 1 super administrateur et 2 administrateurs');
  return { superAdmin, admins: [admin1, admin2] };
}

async function seedDrivers(createdById: string, restaurantId: string) {
  const drivers = [];

  for (const [index, driver] of DRIVERS.entries()) {
    const created = await prisma.user.create({
      data: {
        restaurantId,
        firstName: driver.firstName,
        lastName: driver.lastName,
        email: driver.email,
        phone: driver.phone,
        passwordHash: hash(PASSWORDS.driver),
        role: Role.DRIVER,
        status: AccountStatus.ACTIVE,
        createdById,
        // Les livreurs du jeu de démonstration ont déjà changé leur mot de
        // passe : ils sont directement utilisables.
        mustChangePassword: false,
        lastLoginAt: daysAgo(0, 7),
        driverProfile: {
          create: {
            driverCode: `LIV-${String(index + 1).padStart(3, '0')}`,
            vehicleType: driver.vehicle,
            plateNumber: driver.plate,
            zone: driver.zone,
            isOnline: index < 3,
            isAvailable: index < 3,
            rating: Math.round((4.2 + Math.random() * 0.8) * 10) / 10,
            completedDeliveries: randomInt(30, 220),
            cancelledDeliveries: randomInt(0, 8),
            totalDistanceMeters: randomInt(200_000, 1_500_000),
            totalDeliveryMinutes: randomInt(900, 6000),
            lastLatitude: 9.509167 + (Math.random() - 0.5) * 0.08,
            lastLongitude: -13.712222 + (Math.random() - 0.5) * 0.08,
            lastPositionAt: new Date(),
            lastSeenAt: new Date(),
          },
        },
      },
      include: { driverProfile: true },
    });

    drivers.push(created);
  }

  console.log(`   • ${drivers.length} livreurs`);
  return drivers;
}

async function seedCustomers() {
  const customers = [];

  for (const [index, customer] of CUSTOMERS.entries()) {
    const created = await prisma.user.create({
      data: {
        // Pas de `restaurantId` : un client commande où il veut.
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        passwordHash: hash(PASSWORDS.customer),
        role: Role.CUSTOMER,
        // Un client suspendu : le back-office doit pouvoir en montrer un.
        status: index === 9 ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE,
        lastLoginAt: daysAgo(randomInt(0, 5)),
        lastActivityAt: daysAgo(randomInt(0, 3)),
        customerProfile: { create: { loyaltyPoints: randomInt(0, 120) } },
        cart: { create: {} },
        addresses: {
          create: [
            {
              label: 'Domicile',
              street: customer.street,
              district: customer.district,
              city: 'Conakry',
              latitude: 9.509167 + (Math.random() - 0.5) * 0.1,
              longitude: -13.712222 + (Math.random() - 0.5) * 0.1,
              phone: customer.phone,
              instructions: index % 3 === 0 ? 'Appeler en arrivant.' : null,
              isDefault: true,
            },
          ],
        },
      },
      include: { addresses: true, customerProfile: true },
    });

    customers.push(created);
  }

  console.log(`   • ${customers.length} clients`);
  return customers;
}

async function seedPromotions() {
  const now = new Date();

  const promotions = await Promise.all([
    prisma.promotion.create({
      data: {
        name: 'Bienvenue au Bercail',
        description: '10 % sur votre première commande.',
        code: 'BIENVENUE10',
        type: PromotionType.PERCENTAGE,
        value: 10,
        minimumOrder: 80000,
        maxDiscount: 30000,
        perCustomerLimit: 1,
        startsAt: daysAgo(30),
        endsAt: new Date(now.getFullYear() + 1, 11, 31),
        isActive: true,
      },
    }),
    prisma.promotion.create({
      data: {
        name: 'Livraison offerte',
        description: 'Frais de livraison offerts dès 200 000 GNF.',
        code: 'LIVRAISON0',
        type: PromotionType.FREE_DELIVERY,
        value: 0,
        minimumOrder: 200000,
        startsAt: daysAgo(15),
        endsAt: new Date(now.getTime() + 60 * 24 * 3600 * 1000),
        isActive: true,
      },
    }),
    prisma.promotion.create({
      data: {
        name: 'Vendredi grillades',
        description: '25 000 GNF de remise sur les grillades.',
        code: 'GRILL25',
        type: PromotionType.FIXED,
        value: 25000,
        minimumOrder: 150000,
        usageLimit: 200,
        startsAt: daysAgo(10),
        endsAt: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        isActive: true,
      },
    }),
    prisma.promotion.create({
      data: {
        name: 'Ramadan 2025',
        description: 'Promotion terminée — conservée pour l’historique.',
        code: 'RAMADAN15',
        type: PromotionType.PERCENTAGE,
        value: 15,
        minimumOrder: 100000,
        startsAt: daysAgo(200),
        endsAt: daysAgo(160),
        isActive: false,
      },
    }),
  ]);

  console.log(`   • ${promotions.length} promotions`);
  return promotions;
}

/**
 * Commandes réalistes réparties sur 45 jours, à tous les stades du cycle
 * de vie, avec leurs paiements et leurs livraisons.
 */
async function seedOrders(context: {
  restaurant: { id: string; deliveryFee: number; freeDeliveryThreshold: number | null };
  menuItems: Awaited<ReturnType<typeof seedMenu>>['menuItems'];
  customers: Awaited<ReturnType<typeof seedCustomers>>;
  drivers: Awaited<ReturnType<typeof seedDrivers>>;
  admins: { id: string }[];
  promotions: { id: string; code: string; type: PromotionType; value: number; minimumOrder: number; maxDiscount: number | null }[];
}): Promise<void> {
  const { restaurant, menuItems, customers, drivers, admins, promotions } = context;

  // Répartition volontaire : un back-office ouvert doit montrer des
  // commandes à chaque étape, pas seulement des commandes livrées.
  const plan: { status: OrderStatus; count: number; ageDays: () => number }[] = [
    { status: OrderStatus.DELIVERED, count: 28, ageDays: () => randomInt(2, 45) },
    { status: OrderStatus.CANCELLED, count: 4, ageDays: () => randomInt(1, 30) },
    { status: OrderStatus.PENDING, count: 3, ageDays: () => 0 },
    { status: OrderStatus.CONFIRMED, count: 2, ageDays: () => 0 },
    { status: OrderStatus.PREPARING, count: 3, ageDays: () => 0 },
    { status: OrderStatus.READY, count: 2, ageDays: () => 0 },
    { status: OrderStatus.ASSIGNED, count: 2, ageDays: () => 0 },
    { status: OrderStatus.OUT_FOR_DELIVERY, count: 3, ageDays: () => 0 },
  ];

  let index = 0;

  for (const bucket of plan) {
    for (let i = 0; i < bucket.count; i += 1) {
      index += 1;
      const customer = pick(customers.filter((entry) => entry.status === AccountStatus.ACTIVE));
      const createdAt = daysAgo(bucket.ageDays(), randomInt(11, 22));
      const type = Math.random() > 0.2 ? OrderType.DELIVERY : OrderType.PICKUP;

      // 1 à 4 lignes, options comprises.
      const lineCount = randomInt(1, 5);
      const chosen = new Set<string>();
      const lines = [];

      for (let line = 0; line < lineCount; line += 1) {
        const item = pick(menuItems);
        if (chosen.has(item.id)) continue;
        chosen.add(item.id);

        const quantity = randomInt(1, 3);
        const group = item.optionGroups?.[0];
        const option = group?.options?.[randomInt(0, group.options.length)];
        const extra = option?.extraPrice ?? 0;
        const unitPrice = item.promoPrice ?? item.price;

        lines.push({
          menuItemId: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          unitPrice,
          quantity,
          lineTotal: (unitPrice + extra) * quantity,
          option:
            option && group
              ? { optionId: option.id, groupName: group.name, optionName: option.name, extraPrice: extra }
              : null,
        });
      }

      const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);

      const usePromotion = Math.random() > 0.75;
      const promotion = usePromotion
        ? promotions.find((entry) => entry.minimumOrder <= subtotal && entry.code !== 'RAMADAN15')
        : undefined;

      const baseDeliveryFee = type === OrderType.DELIVERY ? restaurant.deliveryFee : 0;
      const deliveryFee =
        type === OrderType.DELIVERY &&
        restaurant.freeDeliveryThreshold !== null &&
        subtotal >= restaurant.freeDeliveryThreshold
          ? 0
          : baseDeliveryFee;

      let discount = 0;
      if (promotion) {
        if (promotion.type === PromotionType.PERCENTAGE) {
          discount = Math.min(
            Math.floor((subtotal * promotion.value) / 100),
            promotion.maxDiscount ?? Number.MAX_SAFE_INTEGER,
          );
        } else if (promotion.type === PromotionType.FIXED) {
          discount = Math.min(promotion.value, subtotal);
        } else {
          discount = deliveryFee;
        }
      }

      const total = Math.max(0, subtotal + deliveryFee - discount);
      const method = pick([
        PaymentMethod.CASH_ON_DELIVERY,
        PaymentMethod.ORANGE_MONEY,
        PaymentMethod.MTN_MONEY,
        PaymentMethod.CASH_ON_DELIVERY,
      ]);

      const isDelivered = bucket.status === OrderStatus.DELIVERED;
      const isCancelled = bucket.status === OrderStatus.CANCELLED;

      const paymentStatus = isDelivered
        ? PaymentStatus.PAID
        : isCancelled
          ? PaymentStatus.FAILED
          : method === PaymentMethod.CASH_ON_DELIVERY
            ? PaymentStatus.PENDING
            : pick([PaymentStatus.PENDING, PaymentStatus.PAID]);

      const address = customer.addresses[0];

      const order = await prisma.order.create({
        data: {
          reference: reference(index, createdAt),
          customerId: customer.id,
          restaurantId: restaurant.id,
          addressId: type === OrderType.DELIVERY ? address.id : null,
          addressSnapshot:
            type === OrderType.DELIVERY
              ? {
                  id: address.id,
                  label: address.label,
                  street: address.street,
                  district: address.district,
                  city: address.city,
                  latitude: address.latitude,
                  longitude: address.longitude,
                  phone: address.phone,
                  instructions: address.instructions,
                }
              : undefined,
          type,
          status: bucket.status,
          subtotal,
          deliveryFee,
          discount,
          total,
          paymentMethod: method,
          paymentStatus,
          promotionId: promotion?.id ?? null,
          promotionCode: promotion?.code ?? null,
          note: Math.random() > 0.8 ? 'Sans piment, merci.' : null,
          createdAt,
          estimatedReadyAt: minutesAfter(createdAt, 25),
          estimatedDeliveryAt:
            type === OrderType.DELIVERY ? minutesAfter(createdAt, 55) : null,
          deliveredAt: isDelivered ? minutesAfter(createdAt, randomInt(35, 75)) : null,
          cancelledAt: isCancelled ? minutesAfter(createdAt, randomInt(3, 20)) : null,
          cancellationReason: isCancelled
            ? pick(['Client injoignable', 'Rupture de stock', 'Annulée par le client'])
            : null,
          items: {
            create: lines.map((line) => ({
              menuItemId: line.menuItemId,
              name: line.name,
              imageUrl: line.imageUrl,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
              options: line.option
                ? {
                    create: [
                      {
                        optionId: line.option.optionId,
                        groupName: line.option.groupName,
                        optionName: line.option.optionName,
                        extraPrice: line.option.extraPrice,
                      },
                    ],
                  }
                : undefined,
            })),
          },
          payment: {
            create: {
              transactionRef: `TRX-${createdAt.getTime().toString(36).toUpperCase()}-${index}`,
              customerId: customer.id,
              method,
              status: paymentStatus,
              amount: total,
              fee: method === PaymentMethod.CASH_ON_DELIVERY ? 0 : Math.floor(total * 0.01),
              maskedAccount:
                method === PaymentMethod.CASH_ON_DELIVERY ? null : `${customer.phone.slice(0, 7)}****`,
              paidAt: paymentStatus === PaymentStatus.PAID ? minutesAfter(createdAt, 3) : null,
              createdAt,
              events: {
                create: [
                  { label: 'Paiement initialisé', status: PaymentStatus.PENDING, createdAt },
                  ...(paymentStatus === PaymentStatus.PAID
                    ? [
                        {
                          label: 'Paiement confirmé',
                          status: PaymentStatus.PAID,
                          createdAt: minutesAfter(createdAt, 3),
                        },
                      ]
                    : []),
                ],
              },
            },
          },
        },
      });

      await seedOrderHistory(order.id, bucket.status, createdAt, customer.id, pick(admins).id);

      if (promotion) {
        await prisma.couponUsage.create({
          data: {
            promotionId: promotion.id,
            userId: customer.id,
            orderId: order.id,
            discountAmount: discount,
            createdAt,
          },
        });
        await prisma.promotion.update({
          where: { id: promotion.id },
          data: { usageCount: { increment: 1 } },
        });
      }

      // Livraisons pour les commandes concernées.
      const withDelivery: OrderStatus[] = [
        OrderStatus.ASSIGNED,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
      ];
      const needsDelivery = type === OrderType.DELIVERY && withDelivery.includes(bucket.status);

      if (needsDelivery) {
        await seedDelivery(order.id, bucket.status, createdAt, pick(drivers), pick(admins).id);
      }

      // Compteurs client.
      if (isDelivered) {
        await prisma.customerProfile.updateMany({
          where: { userId: customer.id },
          data: {
            ordersCount: { increment: 1 },
            totalSpent: { increment: total },
            loyaltyPoints: { increment: Math.floor(total / 10_000) },
            lastOrderAt: createdAt,
          },
        });
      } else if (isCancelled) {
        await prisma.customerProfile.updateMany({
          where: { userId: customer.id },
          data: { cancelledOrders: { increment: 1 } },
        });
      } else {
        await prisma.customerProfile.updateMany({
          where: { userId: customer.id },
          data: { ordersCount: { increment: 1 }, lastOrderAt: createdAt },
        });
      }
    }
  }

  console.log(`   • ${index} commandes, paiements et livraisons`);
}

async function seedOrderHistory(
  orderId: string,
  status: OrderStatus,
  createdAt: Date,
  customerId: string,
  adminId: string,
): Promise<void> {
  const timeline: OrderStatus[] = [
    OrderStatus.PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.ASSIGNED,
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.DELIVERED,
  ];

  const target = status === OrderStatus.CANCELLED ? 1 : timeline.indexOf(status) + 1;
  const events = timeline.slice(0, Math.max(1, target));

  await prisma.orderStatusHistory.createMany({
    data: events.map((step, position) => ({
      orderId,
      status: step,
      comment: null,
      actorId: position === 0 ? customerId : adminId,
      createdAt: minutesAfter(createdAt, position * 8),
    })),
  });

  if (status === OrderStatus.CANCELLED) {
    await prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.CANCELLED,
        comment: 'Commande annulée',
        actorId: adminId,
        createdAt: minutesAfter(createdAt, 12),
      },
    });
  }
}

async function seedDelivery(
  orderId: string,
  orderStatus: OrderStatus | (typeof OrderStatus)[keyof typeof OrderStatus],
  createdAt: Date,
  driver: { driverProfile: { id: string } | null },
  assignedById: string,
): Promise<void> {
  if (!driver.driverProfile) return;

  const status =
    orderStatus === OrderStatus.DELIVERED
      ? DeliveryStatus.DELIVERED
      : orderStatus === OrderStatus.OUT_FOR_DELIVERY
        ? DeliveryStatus.IN_TRANSIT
        : DeliveryStatus.ASSIGNED;

  const assignedAt = minutesAfter(createdAt, 30);

  const delivery = await prisma.delivery.create({
    data: {
      orderId,
      driverId: driver.driverProfile.id,
      status,
      assignedAt,
      assignedById,
      acceptedAt: status !== DeliveryStatus.ASSIGNED ? minutesAfter(assignedAt, 2) : null,
      pickedUpAt:
        status === DeliveryStatus.IN_TRANSIT || status === DeliveryStatus.DELIVERED
          ? minutesAfter(assignedAt, 8)
          : null,
      inTransitAt: status === DeliveryStatus.IN_TRANSIT ? minutesAfter(assignedAt, 10) : null,
      deliveredAt: status === DeliveryStatus.DELIVERED ? minutesAfter(assignedAt, 28) : null,
      distanceMeters: randomInt(800, 9000),
      estimatedArrivalAt: minutesAfter(assignedAt, 25),
      createdAt: assignedAt,
      events: {
        create: [
          { status: DeliveryStatus.ASSIGNED, comment: 'Course attribuée', createdAt: assignedAt },
          ...(status !== DeliveryStatus.ASSIGNED
            ? [
                {
                  status: DeliveryStatus.ACCEPTED,
                  comment: 'Course acceptée',
                  createdAt: minutesAfter(assignedAt, 2),
                },
              ]
            : []),
          ...(status === DeliveryStatus.DELIVERED
            ? [
                {
                  status: DeliveryStatus.DELIVERED,
                  comment: 'Remise confirmée par code',
                  createdAt: minutesAfter(assignedAt, 28),
                },
              ]
            : []),
        ],
      },
    },
  });

  // Code de remise pour les courses encore en cours (code de test : 1234).
  if (status !== DeliveryStatus.DELIVERED) {
    await prisma.deliveryVerificationCode.create({
      data: {
        deliveryId: delivery.id,
        codeHash: sha256('1234'),
        expiresAt: new Date(Date.now() + 6 * 3600 * 1000),
      },
    });
  }

  // Quelques points GPS pour rejouer le trajet.
  if (status === DeliveryStatus.IN_TRANSIT) {
    await prisma.driverLocation.createMany({
      data: Array.from({ length: 6 }, (_, step) => ({
        driverId: driver.driverProfile!.id,
        deliveryId: delivery.id,
        latitude: 9.509167 + step * 0.002 + (Math.random() - 0.5) * 0.001,
        longitude: -13.712222 + step * 0.0018 + (Math.random() - 0.5) * 0.001,
        accuracy: randomInt(4, 20),
        speed: randomInt(4, 14),
        recordedAt: minutesAfter(assignedAt, 10 + step * 2),
      })),
    });
  }
}

/* ──────────────────────── Gestion d'exploitation ────────────────────────── */

/** Référence d'une pièce de gestion : achat, dépense, recette, salaire. */
function docReference(prefix: string, index: number, date: Date): string {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 3; i += 1) suffix += alphabet[randomInt(0, alphabet.length)];
  return `${prefix}-${year}${month}${day}-${suffix}${index % 10}`;
}

/** Mois `AAAA-MM` d'une date. */
function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Fournisseurs, stock, achats, charges, personnel.
 *
 * L'objectif est qu'un rapport d'activité ouvert le premier jour ait
 * quelque chose à raconter : des achats de poulet et de riz, des factures
 * d'électricité, une paie versée, et un stock qui a bougé.
 */
async function seedOperations(authorId: string, restaurantId: string) {
  const suppliers = await Promise.all(
    [
      {
        name: 'Volailles de Coyah',
        contactName: 'Mamadou Barry',
        phone: '622334455',
        speciality: 'Poulet, œufs',
        address: 'Marché de Coyah',
      },
      {
        name: 'Grossiste Madina',
        contactName: 'Aïssatou Sow',
        phone: '628112233',
        speciality: 'Riz, huile, épicerie',
        address: 'Marché Madina, Conakry',
      },
      {
        name: 'Maraîchers de Kindia',
        contactName: 'Ibrahima Camara',
        phone: '664778899',
        speciality: 'Légumes et fruits frais',
        address: 'Kindia',
      },
      {
        name: 'Boissons Kaloum',
        contactName: 'Fatoumata Diallo',
        phone: '621445566',
        speciality: 'Boissons et emballages',
        address: 'Kaloum, Conakry',
      },
    ].map((supplier) => prisma.supplier.create({ data: { ...supplier, restaurantId } })),
  );

  const [volailles, grossiste, maraichers, boissons] = suppliers;

  const stockPlan: {
    name: string;
    reference: string;
    category: StockCategory;
    unit: StockUnit;
    quantity: number;
    minQuantity: number;
    averageCost: number;
    supplierId: string;
  }[] = [
    {
      name: 'Poulet entier',
      reference: 'ING-POULET',
      category: StockCategory.VIANDE,
      unit: StockUnit.KG,
      quantity: 42,
      minQuantity: 20,
      averageCost: 45000,
      supplierId: volailles.id,
    },
    {
      name: 'Poisson (bar)',
      reference: 'ING-BAR',
      category: StockCategory.POISSON,
      unit: StockUnit.KG,
      quantity: 18,
      minQuantity: 10,
      averageCost: 60000,
      supplierId: maraichers.id,
    },
    {
      name: 'Riz local',
      reference: 'ING-RIZ',
      category: StockCategory.EPICERIE,
      unit: StockUnit.SAC,
      quantity: 6,
      minQuantity: 3,
      averageCost: 420000,
      supplierId: grossiste.id,
    },
    {
      name: 'Huile de palme',
      reference: 'ING-HUILE',
      category: StockCategory.EPICERIE,
      unit: StockUnit.L,
      quantity: 24,
      minQuantity: 15,
      averageCost: 22000,
      supplierId: grossiste.id,
    },
    {
      name: 'Oignons',
      reference: 'ING-OIGNON',
      category: StockCategory.LEGUME,
      unit: StockUnit.KG,
      quantity: 8,
      minQuantity: 12,
      averageCost: 15000,
      supplierId: maraichers.id,
    },
    {
      name: 'Tomates fraîches',
      reference: 'ING-TOMATE',
      category: StockCategory.LEGUME,
      unit: StockUnit.KG,
      quantity: 14,
      minQuantity: 10,
      averageCost: 18000,
      supplierId: maraichers.id,
    },
    {
      name: 'Attiéké',
      reference: 'ING-ATTIEKE',
      category: StockCategory.EPICERIE,
      unit: StockUnit.KG,
      quantity: 30,
      minQuantity: 15,
      averageCost: 12000,
      supplierId: grossiste.id,
    },
    {
      name: 'Eau minérale 1,5 L',
      reference: 'BOI-EAU15',
      category: StockCategory.BOISSON,
      unit: StockUnit.CARTON,
      quantity: 12,
      minQuantity: 6,
      averageCost: 95000,
      supplierId: boissons.id,
    },
    {
      name: 'Barquettes à emporter',
      reference: 'EMB-BARQ',
      category: StockCategory.EMBALLAGE,
      unit: StockUnit.CARTON,
      quantity: 4,
      minQuantity: 5,
      averageCost: 180000,
      supplierId: boissons.id,
    },
    {
      name: 'Charbon de bois',
      reference: 'ENT-CHARBON',
      category: StockCategory.AUTRE,
      unit: StockUnit.SAC,
      quantity: 0,
      minQuantity: 4,
      averageCost: 65000,
      supplierId: grossiste.id,
    },
  ];

  const stockItems = await Promise.all(
    stockPlan.map((item) =>
      // Le stock part de zéro : il est le résultat des mouvements, jamais un
      // chiffre posé à la main. C'est la règle du module, le seed s'y plie
      // comme le reste de l'application.
      prisma.stockItem.create({ data: { ...item, quantity: 0, restaurantId } }),
    ),
  );

  const itemByReference = new Map(stockItems.map((item) => [item.reference!, item]));

  /** Mouvements à rejouer, dans l'ordre chronologique. */
  const movements: {
    reference: string;
    type: StockMovementType;
    reason: StockMovementReason;
    quantity: number;
    unitCost: number;
    occurredAt: Date;
    note: string;
    purchaseId?: string;
  }[] = [];

  // ── Approvisionnements des dix dernières semaines ───────────────────────
  const purchasePlan: {
    supplierId: string;
    ageDays: number;
    lines: { reference: string; quantity: number; unitPrice: number }[];
  }[] = [
    {
      supplierId: volailles.id,
      ageDays: 2,
      lines: [{ reference: 'ING-POULET', quantity: 40, unitPrice: 45000 }],
    },
    {
      supplierId: maraichers.id,
      ageDays: 3,
      lines: [
        { reference: 'ING-OIGNON', quantity: 25, unitPrice: 15000 },
        { reference: 'ING-TOMATE', quantity: 20, unitPrice: 18000 },
      ],
    },
    {
      supplierId: grossiste.id,
      ageDays: 8,
      lines: [
        { reference: 'ING-RIZ', quantity: 8, unitPrice: 420000 },
        { reference: 'ING-HUILE', quantity: 30, unitPrice: 22000 },
      ],
    },
    {
      supplierId: boissons.id,
      ageDays: 12,
      lines: [
        { reference: 'BOI-EAU15', quantity: 15, unitPrice: 95000 },
        { reference: 'EMB-BARQ', quantity: 6, unitPrice: 180000 },
      ],
    },
    {
      supplierId: volailles.id,
      ageDays: 16,
      lines: [{ reference: 'ING-POULET', quantity: 35, unitPrice: 44000 }],
    },
    {
      supplierId: grossiste.id,
      ageDays: 34,
      lines: [
        { reference: 'ING-RIZ', quantity: 10, unitPrice: 415000 },
        { reference: 'ING-ATTIEKE', quantity: 40, unitPrice: 12000 },
      ],
    },
    {
      supplierId: volailles.id,
      ageDays: 41,
      lines: [{ reference: 'ING-POULET', quantity: 38, unitPrice: 43000 }],
    },
  ];

  let documentIndex = 0;

  for (const plan of purchasePlan) {
    documentIndex += 1;
    const purchasedAt = daysAgo(plan.ageDays, 8);

    const lines = plan.lines.map((line) => {
      const item = itemByReference.get(line.reference)!;
      return {
        stockItemId: item.id,
        name: item.name,
        unit: item.unit,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.quantity * line.unitPrice,
      };
    });

    const totalAmount = lines.reduce((total, line) => total + line.lineTotal, 0);
    // Le dernier achat reste à crédit : le back-office doit avoir une
    // facture en attente à montrer.
    const status = plan.ageDays <= 2 ? ExpenseStatus.PENDING : ExpenseStatus.PAID;

    const purchase = await prisma.purchase.create({
      data: {
        restaurantId,
        reference: docReference('ACH', documentIndex, purchasedAt),
        supplierId: plan.supplierId,
        purchasedAt,
        totalAmount,
        paymentMethod: FinancePaymentMethod.CASH,
        status,
        createdById: authorId,
        createdAt: purchasedAt,
        items: { create: lines },
      },
    });

    for (const line of plan.lines) {
      movements.push({
        reference: line.reference,
        type: StockMovementType.IN,
        reason: StockMovementReason.PURCHASE,
        quantity: line.quantity,
        unitCost: line.unitPrice,
        occurredAt: purchasedAt,
        note: `Achat ${purchase.reference}`,
        purchaseId: purchase.id,
      });
    }

    await prisma.expense.create({
      data: {
        restaurantId,
        reference: docReference('DEP', documentIndex, purchasedAt),
        label: `Approvisionnement ${purchase.reference}`,
        category: ExpenseCategory.INGREDIENTS,
        amount: totalAmount,
        status,
        paymentMethod: FinancePaymentMethod.CASH,
        incurredAt: purchasedAt,
        paidAt: status === ExpenseStatus.PAID ? purchasedAt : null,
        supplierId: plan.supplierId,
        purchaseId: purchase.id,
        createdById: authorId,
        createdAt: purchasedAt,
      },
    });
  }

  // ── Sorties de cuisine et pertes ────────────────────────────────────────
  const consumptionPlan: {
    reference: string;
    quantity: number;
    ageDays: number;
    reason: StockMovementReason;
  }[] = [
    { reference: 'ING-POULET', quantity: 12, ageDays: 1, reason: StockMovementReason.PREPARATION },
    { reference: 'ING-RIZ', quantity: 2, ageDays: 1, reason: StockMovementReason.PREPARATION },
    { reference: 'ING-OIGNON', quantity: 9, ageDays: 2, reason: StockMovementReason.PREPARATION },
    { reference: 'ING-TOMATE', quantity: 3, ageDays: 3, reason: StockMovementReason.WASTE },
    { reference: 'ING-POULET', quantity: 15, ageDays: 4, reason: StockMovementReason.PREPARATION },
    { reference: 'ING-HUILE', quantity: 8, ageDays: 5, reason: StockMovementReason.PREPARATION },
    { reference: 'ENT-CHARBON', quantity: 4, ageDays: 6, reason: StockMovementReason.PREPARATION },
    { reference: 'ING-ATTIEKE', quantity: 10, ageDays: 9, reason: StockMovementReason.PREPARATION },
    { reference: 'ING-BAR', quantity: 6, ageDays: 11, reason: StockMovementReason.PREPARATION },
    { reference: 'EMB-BARQ', quantity: 2, ageDays: 13, reason: StockMovementReason.PREPARATION },
  ];

  for (const consumption of consumptionPlan) {
    movements.push({
      reference: consumption.reference,
      type: StockMovementType.OUT,
      reason: consumption.reason,
      quantity: consumption.quantity,
      unitCost: itemByReference.get(consumption.reference)!.averageCost,
      occurredAt: daysAgo(consumption.ageDays, 18),
      note:
        consumption.reason === StockMovementReason.WASTE ? 'Marchandise abîmée' : 'Sortie cuisine',
    });
  }

  // ── Inventaire d'ouverture ──────────────────────────────────────────────
  // Il est déduit, pas inventé : c'est la quantité qu'il fallait avoir en
  // début de période pour que les entrées et les sorties conduisent au stock
  // visé par le plan.
  const openedAt = daysAgo(70, 8);

  for (const plan of stockPlan) {
    const totals = movements
      .filter((movement) => movement.reference === plan.reference)
      .reduce(
        (sums, movement) => ({
          in: sums.in + (movement.type === StockMovementType.IN ? movement.quantity : 0),
          out: sums.out + (movement.type === StockMovementType.OUT ? movement.quantity : 0),
        }),
        { in: 0, out: 0 },
      );

    const opening = Math.max(0, plan.quantity - totals.in + totals.out);
    if (opening === 0) continue;

    movements.push({
      reference: plan.reference,
      type: StockMovementType.IN,
      reason: StockMovementReason.INVENTORY,
      quantity: opening,
      unitCost: plan.averageCost,
      occurredAt: openedAt,
      note: 'Inventaire d’ouverture',
    });
  }

  // ── Rejeu chronologique ─────────────────────────────────────────────────
  const running = new Map<string, number>(stockPlan.map((plan) => [plan.reference, 0]));

  for (const movement of [...movements].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  )) {
    const item = itemByReference.get(movement.reference)!;
    const before = running.get(movement.reference) ?? 0;

    // Une sortie ne creuse jamais le stock sous zéro, même dans un jeu de
    // démonstration : le journal doit rester lisible.
    const quantity =
      movement.type === StockMovementType.OUT
        ? Math.min(movement.quantity, before)
        : movement.quantity;
    if (quantity <= 0) continue;

    const after =
      movement.type === StockMovementType.IN
        ? Math.round((before + quantity) * 1000) / 1000
        : Math.round((before - quantity) * 1000) / 1000;
    running.set(movement.reference, after);

    await prisma.stockMovement.create({
      data: {
        restaurantId,
        stockItemId: item.id,
        type: movement.type,
        reason: movement.reason,
        quantity,
        quantityAfter: after,
        unitCost: movement.unitCost,
        totalCost: Math.round(quantity * movement.unitCost),
        note: movement.note,
        purchaseId: movement.purchaseId ?? null,
        createdById: authorId,
        occurredAt: movement.occurredAt,
        createdAt: movement.occurredAt,
      },
    });
  }

  for (const item of stockItems) {
    await prisma.stockItem.update({
      where: { id: item.id },
      data: {
        quantity: running.get(item.reference!) ?? 0,
        lastPurchaseCost: item.averageCost,
        lastPurchaseAt: daysAgo(randomInt(1, 12), 9),
      },
    });
  }

  // ── Personnel ───────────────────────────────────────────────────────────
  const employees = await Promise.all(
    [
      { firstName: 'Sékou', lastName: 'Condé', position: 'Chef de cuisine', baseSalary: 3_500_000, contractType: ContractType.CDI, phone: '622101010' },
      { firstName: 'Aminata', lastName: 'Bah', position: 'Cuisinière', baseSalary: 2_200_000, contractType: ContractType.CDI, phone: '622202020' },
      { firstName: 'Mohamed', lastName: 'Sylla', position: 'Serveur', baseSalary: 1_500_000, contractType: ContractType.CDD, phone: '622303030' },
      { firstName: 'Kadiatou', lastName: 'Touré', position: 'Caissière', baseSalary: 1_800_000, contractType: ContractType.CDI, phone: '622404040' },
      { firstName: 'Ousmane', lastName: 'Keita', position: 'Plongeur', baseSalary: 1_100_000, contractType: ContractType.JOURNALIER, phone: '622505050' },
      { firstName: 'Mariama', lastName: 'Diallo', position: 'Serveuse', baseSalary: 1_500_000, contractType: ContractType.CDD, phone: '622606060' },
    ].map((employee, index) =>
      prisma.employee.create({
        data: {
          restaurantId,
          ...employee,
          status: EmployeeStatus.ACTIVE,
          hiredAt: daysAgo(120 + index * 45, 9),
        },
      }),
    ),
  );

  // ── Charges du restaurant, sur trois mois ───────────────────────────────
  const chargePlan: {
    label: string;
    category: ExpenseCategory;
    amount: number;
    ageDays: number;
    status: ExpenseStatus;
    isRecurring: boolean;
    dueInDays?: number;
  }[] = [
    { label: 'Loyer du local', category: ExpenseCategory.LOYER, amount: 4_000_000, ageDays: 3, status: ExpenseStatus.PAID, isRecurring: true },
    { label: 'Facture EDG (électricité)', category: ExpenseCategory.ELECTRICITE, amount: 1_850_000, ageDays: 5, status: ExpenseStatus.PENDING, isRecurring: true, dueInDays: 9 },
    { label: 'Facture SEG (eau)', category: ExpenseCategory.EAU, amount: 420_000, ageDays: 6, status: ExpenseStatus.PAID, isRecurring: true },
    { label: 'Abonnement internet', category: ExpenseCategory.COMMUNICATION, amount: 350_000, ageDays: 8, status: ExpenseStatus.PAID, isRecurring: true },
    { label: 'Carburant des livreurs', category: ExpenseCategory.CARBURANT, amount: 900_000, ageDays: 10, status: ExpenseStatus.PAID, isRecurring: false },
    { label: 'Réparation du congélateur', category: ExpenseCategory.MAINTENANCE, amount: 750_000, ageDays: 14, status: ExpenseStatus.PAID, isRecurring: false },
    { label: 'Loyer du local', category: ExpenseCategory.LOYER, amount: 4_000_000, ageDays: 33, status: ExpenseStatus.PAID, isRecurring: true },
    { label: 'Facture EDG (électricité)', category: ExpenseCategory.ELECTRICITE, amount: 1_620_000, ageDays: 35, status: ExpenseStatus.PAID, isRecurring: true },
    { label: 'Facture SEG (eau)', category: ExpenseCategory.EAU, amount: 390_000, ageDays: 36, status: ExpenseStatus.PAID, isRecurring: true },
    { label: 'Publicité radio', category: ExpenseCategory.MARKETING, amount: 1_200_000, ageDays: 40, status: ExpenseStatus.PAID, isRecurring: false },
    { label: 'Patente et taxes communales', category: ExpenseCategory.TAXES, amount: 2_100_000, ageDays: 52, status: ExpenseStatus.PAID, isRecurring: false },
    { label: 'Loyer du local', category: ExpenseCategory.LOYER, amount: 4_000_000, ageDays: 63, status: ExpenseStatus.PAID, isRecurring: true },
  ];

  for (const charge of chargePlan) {
    documentIndex += 1;
    const incurredAt = daysAgo(charge.ageDays, 10);
    await prisma.expense.create({
      data: {
        restaurantId,
        reference: docReference('DEP', documentIndex, incurredAt),
        label: charge.label,
        category: charge.category,
        amount: charge.amount,
        status: charge.status,
        paymentMethod: FinancePaymentMethod.CASH,
        incurredAt,
        paidAt: charge.status === ExpenseStatus.PAID ? incurredAt : null,
        dueDate:
          charge.dueInDays !== undefined
            ? new Date(Date.now() + charge.dueInDays * 86_400_000)
            : null,
        period: periodOf(incurredAt),
        isRecurring: charge.isRecurring,
        createdById: authorId,
        createdAt: incurredAt,
      },
    });
  }

  // ── Salaires des deux mois précédents ───────────────────────────────────
  for (const monthsAgo of [1, 2]) {
    const payDate = daysAgo(monthsAgo * 30, 16);
    for (const employee of employees) {
      documentIndex += 1;
      await prisma.expense.create({
        data: {
          restaurantId,
          reference: docReference('SAL', documentIndex, payDate),
          label: `Salaire ${periodOf(payDate)} — ${employee.firstName} ${employee.lastName}`,
          category: ExpenseCategory.SALAIRE,
          amount: employee.baseSalary,
          status: ExpenseStatus.PAID,
          paymentMethod: FinancePaymentMethod.CASH,
          incurredAt: payDate,
          paidAt: payDate,
          period: periodOf(payDate),
          employeeId: employee.id,
          createdById: authorId,
          createdAt: payDate,
        },
      });
    }
  }

  // ── Recettes hors vente ─────────────────────────────────────────────────
  const incomePlan: { label: string; category: IncomeCategory; amount: number; ageDays: number }[] = [
    { label: 'Location de la salle — baptême', category: IncomeCategory.LOCATION_SALLE, amount: 2_500_000, ageDays: 7 },
    { label: 'Buffet séminaire ONG', category: IncomeCategory.EVENEMENT, amount: 4_800_000, ageDays: 21 },
    { label: 'Remboursement fournisseur (marchandise non conforme)', category: IncomeCategory.REMBOURSEMENT, amount: 320_000, ageDays: 28 },
    { label: 'Location de la salle — anniversaire', category: IncomeCategory.LOCATION_SALLE, amount: 1_800_000, ageDays: 44 },
  ];

  for (const income of incomePlan) {
    documentIndex += 1;
    const receivedAt = daysAgo(income.ageDays, 15);
    await prisma.income.create({
      data: {
        restaurantId,
        reference: docReference('REC', documentIndex, receivedAt),
        label: income.label,
        category: income.category,
        amount: income.amount,
        method: FinancePaymentMethod.CASH,
        receivedAt,
        createdById: authorId,
        createdAt: receivedAt,
      },
    });
  }

  console.log(
    `   • ${suppliers.length} fournisseurs, ${stockItems.length} articles de stock, ${purchasePlan.length} achats`,
  );
  console.log(
    `   • ${employees.length} employés, ${chargePlan.length} charges et ${incomePlan.length} recettes diverses`,
  );

  return { suppliers, stockItems, employees };
}

/**
 * Ventes au comptoir.
 *
 * Le restaurant vend aussi sans passer par l'application : ces commandes
 * n'ont pas de client, mais elles comptent dans le chiffre d'affaires.
 */
async function seedPosOrders(context: {
  restaurant: { id: string };
  menuItems: Awaited<ReturnType<typeof seedMenu>>['menuItems'];
  cashierId: string;
}): Promise<void> {
  const { restaurant, menuItems, cashierId } = context;

  const walkInNames = [
    'Mamadou',
    'Fatou',
    'Ibrahima',
    'Aïcha',
    'Sory',
    'Kadiatou',
    null,
    null,
    'Alpha',
    'Hawa',
  ];

  let created = 0;

  for (let index = 0; index < 26; index += 1) {
    const createdAt = daysAgo(randomInt(0, 30), randomInt(11, 22));
    const type = Math.random() > 0.45 ? OrderType.DINE_IN : OrderType.PICKUP;

    const lineCount = randomInt(1, 4);
    const chosen = new Set<string>();
    const lines = [];

    for (let line = 0; line < lineCount; line += 1) {
      const item = pick(menuItems);
      if (chosen.has(item.id)) continue;
      chosen.add(item.id);

      const quantity = randomInt(1, 3);
      const unitPrice = item.promoPrice ?? item.price;
      lines.push({
        menuItemId: item.id,
        name: item.name,
        imageUrl: item.imageUrl,
        unitPrice,
        quantity,
        lineTotal: unitPrice * quantity,
      });
    }

    if (lines.length === 0) continue;

    const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);
    // Une remise de temps en temps : le patron connaît ses habitués.
    const discount = Math.random() > 0.85 ? Math.min(5000 * randomInt(1, 4), subtotal) : 0;
    const total = subtotal - discount;

    const paymentMethod =
      Math.random() > 0.25 ? PaymentMethod.CASH_ON_DELIVERY : PaymentMethod.ORANGE_MONEY;
    const amountReceived =
      paymentMethod === PaymentMethod.CASH_ON_DELIVERY
        ? Math.ceil(total / 5000) * 5000 + (Math.random() > 0.5 ? 5000 : 0)
        : null;

    created += 1;

    await prisma.order.create({
      data: {
        reference: reference(900 + index, createdAt),
        customerId: null,
        restaurantId: restaurant.id,
        channel: OrderChannel.POS,
        walkInName: pick(walkInNames),
        tableNumber: type === OrderType.DINE_IN ? String(randomInt(1, 13)) : null,
        servedById: cashierId,
        amountReceived,
        changeGiven: amountReceived !== null ? amountReceived - total : null,
        type,
        status: OrderStatus.DELIVERED,
        subtotal,
        deliveryFee: 0,
        discount,
        total,
        paymentMethod,
        paymentStatus: PaymentStatus.PAID,
        createdAt,
        updatedAt: createdAt,
        deliveredAt: minutesAfter(createdAt, randomInt(8, 25)),
        items: {
          create: lines.map((line) => ({
            menuItemId: line.menuItemId,
            name: line.name,
            imageUrl: line.imageUrl,
            unitPrice: line.unitPrice,
            quantity: line.quantity,
            lineTotal: line.lineTotal,
          })),
        },
        history: {
          create: {
            status: OrderStatus.DELIVERED,
            comment: 'Vente au comptoir',
            actorId: cashierId,
            createdAt,
          },
        },
        payment: {
          create: {
            transactionRef: docReference('TRX', index, createdAt),
            customerId: null,
            method: paymentMethod,
            status: PaymentStatus.PAID,
            amount: total,
            paidAt: createdAt,
            createdAt,
            events: {
              create: {
                label: 'Encaissement au comptoir',
                status: PaymentStatus.PAID,
                createdAt,
              },
            },
          },
        },
      },
    });
  }

  console.log(`   • ${created} ventes au comptoir`);
}


/**
 * Fiches techniques de démonstration.
 *
 * Elles ne couvrent pas toute la carte — un restaurant n'en a jamais pour
 * tous ses plats dès le premier jour. Les plats sans fiche continuent de se
 * vendre sans mouvementer le stock, ce qui est exactement le comportement
 * qu'on veut montrer : la fiche est ce qui referme le circuit.
 */
async function seedRecipes(
  menuItems: { id: string; name: string }[],
  stockItems: { id: string; reference: string | null }[],
): Promise<void> {
  const itemByName = new Map(menuItems.map((item) => [item.name, item.id]));
  const stockByReference = new Map(
    stockItems
      .filter((item) => item.reference)
      .map((item) => [item.reference as string, item.id]),
  );

  /** Quantités pour **une** portion, dans l'unité de l'article. */
  const plan: { plat: string; lignes: [string, number][] }[] = [
    {
      plat: 'Poulet braisé entier',
      lignes: [
        ['ING-POULET', 1.2],
        ['ING-OIGNON', 0.15],
        ['ING-HUILE', 0.08],
        ['ENT-CHARBON', 0.05],
        ['EMB-BARQ', 0.01],
      ],
    },
    {
      plat: 'Demi-poulet braisé',
      lignes: [
        ['ING-POULET', 0.6],
        ['ING-OIGNON', 0.08],
        ['ING-HUILE', 0.05],
        ['ENT-CHARBON', 0.03],
      ],
    },
    {
      plat: 'Poulet yassa',
      lignes: [
        ['ING-POULET', 0.7],
        ['ING-OIGNON', 0.35],
        ['ING-HUILE', 0.06],
      ],
    },
    {
      plat: 'Bar grillé',
      lignes: [
        ['ING-BAR', 0.55],
        ['ING-HUILE', 0.04],
        ['ENT-CHARBON', 0.04],
      ],
    },
    {
      plat: 'Riz gras',
      lignes: [
        ['ING-RIZ', 0.008],
        ['ING-TOMATE', 0.08],
        ['ING-HUILE', 0.03],
      ],
    },
    {
      plat: 'Attiéké',
      lignes: [['ING-ATTIEKE', 0.25]],
    },
    {
      plat: 'Fouti (riz sauce)',
      lignes: [
        ['ING-RIZ', 0.01],
        ['ING-TOMATE', 0.12],
        ['ING-OIGNON', 0.06],
        ['ING-HUILE', 0.04],
      ],
    },
  ];

  const lignes: { menuItemId: string; stockItemId: string; quantity: number }[] = [];

  for (const recette of plan) {
    const menuItemId = itemByName.get(recette.plat);
    if (!menuItemId) continue;

    for (const [reference, quantity] of recette.lignes) {
      const stockItemId = stockByReference.get(reference);
      if (!stockItemId) continue;
      lignes.push({ menuItemId, stockItemId, quantity });
    }
  }

  if (lignes.length > 0) {
    await prisma.recipeIngredient.createMany({ data: lignes });
  }

  console.log(`   • ${plan.length} fiches techniques, ${lignes.length} ingrédients`);
}

async function seedNotifications(
  customers: { id: string }[],
  admins: { id: string }[],
  superAdmin: { id: string },
): Promise<void> {
  const data = [
    ...customers.slice(0, 6).map((customer, index) => ({
      userId: customer.id,
      type: index % 2 === 0 ? NotificationType.ORDER_DELIVERED : NotificationType.PROMOTION,
      title: index % 2 === 0 ? 'Bon appétit !' : 'Nouvelle promotion',
      body:
        index % 2 === 0
          ? 'Votre commande a été livrée. Merci de votre confiance.'
          : 'Profitez de 10 % sur votre prochaine commande avec le code BIENVENUE10.',
      isRead: index % 3 === 0,
      createdAt: daysAgo(index),
    })),
    ...[...admins, superAdmin].map((staff, index) => ({
      userId: staff.id,
      type: NotificationType.ORDER_CREATED,
      title: 'Nouvelle commande',
      body: 'Une commande vient d’être passée et attend confirmation.',
      isRead: false,
      createdAt: daysAgo(0, 10 + index),
    })),
  ];

  await prisma.notification.createMany({ data });
  console.log(`   • ${data.length} notifications`);
}

async function seedSecurityAlerts(): Promise<void> {
  await prisma.securityAlert.createMany({
    data: [
      {
        severity: AlertSeverity.MEDIUM,
        title: 'Tentatives de connexion répétées',
        description: 'Cinq échecs de connexion consécutifs sur un compte client.',
        createdAt: daysAgo(1, 22),
      },
      {
        severity: AlertSeverity.LOW,
        title: 'Nouvel appareil administrateur',
        description: 'Connexion depuis un appareil jamais utilisé auparavant.',
        createdAt: daysAgo(3, 9),
      },
    ],
  });
}

async function printSummary(): Promise<void> {
  const [users, orders, deliveries, payments, items] = await Promise.all([
    prisma.user.count(),
    prisma.order.count(),
    prisma.delivery.count(),
    prisma.payment.count(),
    prisma.menuItem.count(),
  ]);

  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  LE BERCAIL — jeu de démonstration                            │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log(`│  ${String(users).padStart(3)} comptes · ${String(items).padStart(3)} plats · ${String(orders).padStart(3)} commandes · ${String(deliveries).padStart(3)} livraisons · ${String(payments).padStart(3)} paiements`);
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log('│  IDENTIFIANTS DE TEST — jamais en production                  │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log(`│  SUPER_ADMIN  superadmin@lebercail.gn        ${PASSWORDS.superAdmin}`);
  console.log(`│  ADMIN        admin@lebercail.gn             ${PASSWORDS.admin}`);
  console.log(`│  ADMIN (carte) admin.carte@lebercail.gn      ${PASSWORDS.admin}`);
  console.log(`│  DRIVER       ibrahima.camara@lebercail.gn   ${PASSWORDS.driver}`);
  console.log(`│  CUSTOMER     mariama.diallo@example.gn      ${PASSWORDS.customer}`);
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log('│  Code de remise des livraisons en cours : 1234                │');
  console.log('│  Codes promo : BIENVENUE10 · LIVRAISON0 · GRILL25             │');
  console.log('└──────────────────────────────────────────────────────────────┘');
}

main()
  .catch((error) => {
    console.error('❌ Seed en échec :', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
