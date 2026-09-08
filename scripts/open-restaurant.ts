/**
 * Ouvre un établissement et l'amorce.
 *
 *     npm run restaurant:open -- --code=BRC2 --name="Le Bercail — Kipé"
 *
 * Une adresse qui ouvre ne part pas de rien dans la vraie vie : elle reprend
 * la carte de la maison mère, monte sa propre réserve, recrute son équipe et
 * commence à vendre. Le script fait exactement cela.
 *
 * Ce qui est **copié** depuis l'établissement source : la carte — rubriques,
 * plats, options. Ce qui lui est **propre** : le stock, les fournisseurs, le
 * personnel, les dépenses, les ventes. C'est le partage qu'impose le choix
 * « établissements indépendants » : même offre au départ, comptabilité
 * séparée pour toujours.
 *
 * Le script est **additif** : il ne touche à aucune donnée existante.
 */
import {
  ExpenseCategory,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  Role,
  StockCategory,
  StockMovementReason,
  StockMovementType,
  StockUnit,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

const prisma = new PrismaClient();

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function arg(name: string, fallback?: string): string {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  const value = found?.split('=').slice(1).join('=');
  if (!value && fallback === undefined) {
    throw new Error(`Argument manquant : --${name}=…`);
  }
  return value || (fallback as string);
}

function reference(prefix: string): string {
  const now = new Date();
  const stamp = `${String(now.getUTCFullYear()).slice(-2)}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 5; i += 1) suffix += alphabet[randomInt(0, alphabet.length)];
  return `${prefix}-${stamp}-${suffix}`;
}

function daysAgo(days: number, hour = 12): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, randomInt(0, 60), 0, 0);
  return date;
}

/* ------------------------------------------------------------------ */

async function main() {
  const code = arg('code').toUpperCase();
  const name = arg('name');
  const city = arg('city', 'Conakry');
  const district = arg('district', 'Ratoma');
  const address = arg('address', 'Kipé, carrefour Constantin');
  const sourceCode = arg('from', 'BRC');

  const existing = await prisma.restaurant.findUnique({ where: { code } });
  if (existing) throw new Error(`Le code « ${code} » est déjà pris par « ${existing.name} ».`);

  const source = await prisma.restaurant.findUnique({ where: { code: sourceCode } });
  if (!source) throw new Error(`Établissement source « ${sourceCode} » introuvable.`);

  console.log(`\nOuverture de « ${name} » (${code}), carte reprise de ${source.name}.\n`);

  /* ---- L'établissement ---- */
  const restaurant = await prisma.restaurant.create({
    data: {
      code,
      name,
      tagline: source.tagline,
      description: source.description,
      phone: `+2246200${randomInt(10000, 99999)}`,
      email: `${code.toLowerCase()}@lebercail.gn`,
      address,
      district,
      city,
      // Décalage volontaire : deux adresses ne sont pas au même endroit,
      // et les distances de livraison doivent s'en ressentir.
      latitude: Number((source.latitude + 0.13).toFixed(6)),
      longitude: Number((source.longitude + 0.09).toFixed(6)),
      deliveryFee: source.deliveryFee + 3000,
      minimumOrderAmount: source.minimumOrderAmount,
      openingHours: {
        create: Array.from({ length: 7 }, (_, index) => ({
          weekday: index + 1,
          opensAt: '09:00',
          closesAt: '23:00',
          isClosed: false,
        })),
      },
    },
  });

  /* ---- La carte, reprise de la maison mère ---- */
  const sourceCategories = await prisma.category.findMany({
    where: { restaurantId: source.id, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    include: {
      menuItems: {
        where: { deletedAt: null },
        include: { optionGroups: { include: { options: true } } },
      },
    },
  });

  let copiedItems = 0;
  const newItems: { id: string; name: string; price: number }[] = [];

  for (const category of sourceCategories) {
    const created = await prisma.category.create({
      data: {
        restaurantId: restaurant.id,
        name: category.name,
        slug: category.slug,
        emoji: category.emoji,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
      },
    });

    for (const item of category.menuItems) {
      const copy = await prisma.menuItem.create({
        data: {
          restaurantId: restaurant.id,
          categoryId: created.id,
          name: item.name,
          shortDescription: item.shortDescription,
          description: item.description,
          // Même carte, mêmes prix au départ : le gérant les ajustera.
          price: item.price,
          promoPrice: item.promoPrice,
          imageUrl: item.imageUrl,
          ingredients: item.ingredients,
          isAvailable: item.isAvailable,
          isPopular: item.isPopular,
          isSuggestion: item.isSuggestion,
          isSpicy: item.isSpicy,
          preparationMinutes: item.preparationMinutes,
          optionGroups: {
            create: item.optionGroups.map((group) => ({
              name: group.name,
              isRequired: group.isRequired,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              sortOrder: group.sortOrder,
              options: {
                create: group.options.map((option) => ({
                  name: option.name,
                  extraPrice: option.extraPrice,
                  isAvailable: option.isAvailable,
                  sortOrder: option.sortOrder,
                })),
              },
            })),
          },
        },
      });

      copiedItems += 1;
      newItems.push({ id: copy.id, name: copy.name, price: copy.promoPrice ?? copy.price });
    }
  }

  /* ---- Ses fournisseurs et sa réserve ---- */
  const suppliers = await Promise.all(
    [
      { name: `Volailles de ${district}`, speciality: 'Poulet et œufs', phone: '622110011' },
      { name: 'Grossiste Kipé', speciality: 'Riz, huile, épicerie', phone: '622110022' },
    ].map((supplier) =>
      prisma.supplier.create({ data: { ...supplier, restaurantId: restaurant.id } }),
    ),
  );

  const stockPlan = [
    { name: 'Poulet entier', reference: 'ING-POULET', category: StockCategory.VIANDE, unit: StockUnit.KG, minQuantity: 20, prix: 42_000, quantite: 45 },
    { name: 'Riz parfumé', reference: 'ING-RIZ', category: StockCategory.EPICERIE, unit: StockUnit.SAC, minQuantity: 2, prix: 480_000, quantite: 6 },
    { name: 'Huile végétale', reference: 'ING-HUILE', category: StockCategory.EPICERIE, unit: StockUnit.L, minQuantity: 10, prix: 18_000, quantite: 24 },
    { name: 'Oignons', reference: 'ING-OIGNON', category: StockCategory.LEGUME, unit: StockUnit.KG, minQuantity: 10, prix: 9_000, quantite: 8 },
    { name: 'Barquettes', reference: 'EMB-BARQ', category: StockCategory.EMBALLAGE, unit: StockUnit.CARTON, minQuantity: 3, prix: 95_000, quantite: 5 },
  ];

  const stockItems = await Promise.all(
    stockPlan.map((item) =>
      prisma.stockItem.create({
        data: {
          restaurantId: restaurant.id,
          name: item.name,
          reference: item.reference,
          category: item.category,
          unit: item.unit,
          minQuantity: item.minQuantity,
          quantity: 0,
          averageCost: 0,
        },
      }),
    ),
  );

  /* ---- Un approvisionnement d'ouverture ---- */
  const purchasedAt = daysAgo(6, 8);
  const lignes = stockPlan.map((item, index) => ({
    stockItem: stockItems[index],
    quantity: item.quantite,
    unitPrice: item.prix,
    lineTotal: Math.round(item.quantite * item.prix),
  }));
  const totalAchat = lignes.reduce((total, ligne) => total + ligne.lineTotal, 0);

  const purchase = await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      reference: reference('ACH'),
      supplierId: suppliers[0].id,
      purchasedAt,
      totalAmount: totalAchat,
      note: 'Approvisionnement d’ouverture',
      items: {
        create: lignes.map((ligne) => ({
          stockItemId: ligne.stockItem.id,
          name: ligne.stockItem.name,
          unit: ligne.stockItem.unit,
          quantity: ligne.quantity,
          unitPrice: ligne.unitPrice,
          lineTotal: ligne.lineTotal,
        })),
      },
    },
  });

  // Le stock est la somme de ses mouvements : on écrit les entrées, puis on
  // aligne l'article — jamais l'inverse.
  for (const ligne of lignes) {
    await prisma.stockMovement.create({
      data: {
        restaurantId: restaurant.id,
        stockItemId: ligne.stockItem.id,
        purchaseId: purchase.id,
        type: StockMovementType.IN,
        reason: StockMovementReason.PURCHASE,
        quantity: ligne.quantity,
        quantityAfter: ligne.quantity,
        unitCost: ligne.unitPrice,
        totalCost: ligne.lineTotal,
        occurredAt: purchasedAt,
      },
    });
    await prisma.stockItem.update({
      where: { id: ligne.stockItem.id },
      data: {
        quantity: ligne.quantity,
        averageCost: ligne.unitPrice,
        lastPurchaseCost: ligne.unitPrice,
        lastPurchaseAt: purchasedAt,
      },
    });
  }

  await prisma.expense.create({
    data: {
      restaurantId: restaurant.id,
      reference: reference('DEP'),
      label: `Approvisionnement ${purchase.reference}`,
      category: ExpenseCategory.INGREDIENTS,
      amount: totalAchat,
      purchaseId: purchase.id,
      supplierId: suppliers[0].id,
      incurredAt: purchasedAt,
      paidAt: purchasedAt,
    },
  });

  /* ---- Ses charges ---- */
  await Promise.all([
    prisma.expense.create({
      data: {
        restaurantId: restaurant.id, reference: reference('DEP'), label: 'Loyer du local',
        category: ExpenseCategory.LOYER, amount: 3_500_000, isRecurring: true,
        incurredAt: daysAgo(5), paidAt: daysAgo(5),
      },
    }),
    prisma.expense.create({
      data: {
        restaurantId: restaurant.id, reference: reference('DEP'), label: 'Facture EDG — ouverture',
        category: ExpenseCategory.ELECTRICITE, amount: 780_000,
        incurredAt: daysAgo(3), dueDate: daysAgo(-10), status: 'PENDING',
      },
    }),
  ]);

  /* ---- Son équipe ---- */
  const passwordHash = bcrypt.hashSync('Admin@2024', 10);
  const suffix = code.toLowerCase();

  const gerant = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      firstName: 'Aminata',
      lastName: 'Camara',
      email: `gerant.${suffix}@lebercail.gn`,
      phone: `+2246210${randomInt(10000, 99999)}`,
      passwordHash,
      role: Role.ADMIN,
      status: 'ACTIVE',
    },
  });

  await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      firstName: 'Sory',
      lastName: 'Kourouma',
      email: `livreur.${suffix}@lebercail.gn`,
      phone: `+2246220${randomInt(10000, 99999)}`,
      passwordHash,
      role: Role.DRIVER,
      status: 'ACTIVE',
      driverProfile: {
        create: {
          driverCode: `LIV-${randomInt(100, 999)}`,
          vehicleType: 'MOTO',
          plateNumber: `RC-${randomInt(1000, 9999)}-K`,
          zone: district,
        },
      },
    },
  });

  const employes = await Promise.all(
    [
      { firstName: 'Ibrahima', lastName: 'Soumah', position: 'Cuisinier', baseSalary: 2_200_000 },
      { firstName: 'Mariama', lastName: 'Bah', position: 'Serveuse', baseSalary: 1_400_000 },
      { firstName: 'Ousmane', lastName: 'Traoré', position: 'Caissier', baseSalary: 1_600_000 },
    ].map((employe) =>
      prisma.employee.create({
        data: { ...employe, restaurantId: restaurant.id, hiredAt: daysAgo(20) },
      }),
    ),
  );

  /* ---- Ses premières ventes ---- */
  let ventes = 0;
  let chiffre = 0;

  for (let index = 0; index < 14; index += 1) {
    const quand = daysAgo(randomInt(0, 5), randomInt(11, 21));
    const choisis = [...newItems].sort(() => Math.random() - 0.5).slice(0, randomInt(1, 3));

    const lignesCommande = choisis.map((item) => {
      const quantity = randomInt(1, 3);
      return { item, quantity, lineTotal: item.price * quantity };
    });
    const total = lignesCommande.reduce((somme, ligne) => somme + ligne.lineTotal, 0);

    await prisma.order.create({
      data: {
        reference: reference(code),
        restaurantId: restaurant.id,
        channel: OrderChannel.POS,
        type: OrderType.DINE_IN,
        status: OrderStatus.DELIVERED,
        tableNumber: String(randomInt(1, 12)),
        servedById: gerant.id,
        subtotal: total,
        deliveryFee: 0,
        discount: 0,
        total,
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        paymentStatus: PaymentStatus.PAID,
        createdAt: quand,
        deliveredAt: quand,
        items: {
          create: lignesCommande.map((ligne) => ({
            menuItemId: ligne.item.id,
            name: ligne.item.name,
            unitPrice: ligne.item.price,
            quantity: ligne.quantity,
            lineTotal: ligne.lineTotal,
          })),
        },
        history: {
          create: { status: OrderStatus.DELIVERED, comment: 'Vente au comptoir', createdAt: quand },
        },
        payment: {
          create: {
            transactionRef: reference('TRX'),
            method: PaymentMethod.CASH_ON_DELIVERY,
            status: PaymentStatus.PAID,
            amount: total,
            paidAt: quand,
            createdAt: quand,
          },
        },
      },
    });

    ventes += 1;
    chiffre += total;
  }

  /* ---- Bilan ---- */
  const gnf = (value: number) => `${new Intl.NumberFormat('fr-FR').format(value)} GNF`;

  console.log(`✅ ${restaurant.name} — code ${restaurant.code}`);
  console.log(`   carte      : ${sourceCategories.length} rubriques, ${copiedItems} plats repris de ${source.code}`);
  console.log(`   réserve    : ${stockItems.length} articles, ${suppliers.length} fournisseurs`);
  console.log(`   achat      : ${gnf(totalAchat)} à l'ouverture`);
  console.log(`   charges    : loyer + électricité (une reste à payer)`);
  console.log(`   équipe     : 1 gérant, 1 livreur, ${employes.length} employés`);
  console.log(`   ventes     : ${ventes} tickets au comptoir, ${gnf(chiffre)}`);
  console.log(`\n   Connexion gérant : ${gerant.email} / Admin@2024\n`);
}

main()
  .catch((error) => {
    console.error('\n❌', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
