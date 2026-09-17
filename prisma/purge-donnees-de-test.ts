/* eslint-disable no-console */
/**
 * Purge des données de test — 12 septembre 2026.
 *
 * Le propriétaire commence à saisir ses vraies données. Tout ce qui
 * venait du seed de démonstration est effacé : clients, livreurs et
 * gérants fictifs, commandes, livraisons, paiements, adresses, stock,
 * dépenses, notifications, promotions.
 *
 * **Conservé** :
 *  • les deux établissements, avec horaires, frais, zones et position ;
 *  • la carte (catégories, plats, options) — à effacer séparément si le
 *    propriétaire préfère repartir de zéro ;
 *  • les réglages système, rôles et permissions ;
 *  • les six comptes du propriétaire, listés ci-dessous.
 *
 * Une copie de la base est faite **avant** (`backups/bercail-avant-purge-*`).
 *
 *   npx ts-node --transpile-only prisma/purge-donnees-de-test.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Les comptes qui survivent à la purge. */
const CONSERVES = [
  'alphaiemail01@gmail.com',
  'superadmin@lebercail.gn',
  'alphonselouainnov@gmail.com',
  'livreur.alphonse@lebercail.gn',
  'gerant.brc2@lebercail.gn',
  'touraj204@gmail.com',
];

async function main() {
  const gardes = await prisma.user.findMany({
    where: { email: { in: CONSERVES } },
    select: { id: true, email: true },
  });
  if (gardes.length !== CONSERVES.length) {
    const manquants = CONSERVES.filter((e) => !gardes.some((g) => g.email === e));
    throw new Error(`Comptes à conserver introuvables : ${manquants.join(', ')}`);
  }
  const ids = gardes.map((g) => g.id);

  await prisma.$transaction(async (tx) => {
    // ── Tout ce qui raconte une activité passée ─────────────────────
    // L'ordre suit les clés étrangères : les enfants avant les parents.
    await tx.$executeRawUnsafe(`
      TRUNCATE TABLE
        delivery_verification_codes, driver_locations, delivery_events, deliveries,
        payment_events, payments,
        order_item_reviews, order_reviews,
        order_item_options, order_items, order_status_history, orders,
        coupon_usages, promotions,
        cart_item_options, cart_items, carts,
        stock_movements, recipe_ingredients, purchase_items, purchases, stock_items, suppliers,
        expenses, incomes, employees,
        notifications, audit_logs, security_alerts,
        sync_outbox, idempotency_keys, device_tokens
      RESTART IDENTITY CASCADE
    `);

    // ── Les comptes fictifs, et ce qui leur appartient ─────────────
    await tx.address.deleteMany({ where: { userId: { notIn: ids } } });
    await tx.favorite.deleteMany({ where: { userId: { notIn: ids } } });
    await tx.refreshToken.deleteMany({ where: { userId: { notIn: ids } } });
    await tx.userPermission.deleteMany({ where: { userId: { notIn: ids } } });
    await tx.driverProfile.deleteMany({ where: { userId: { notIn: ids } } });
    await tx.customerProfile.deleteMany({ where: { userId: { notIn: ids } } });
    const users = await tx.user.deleteMany({ where: { id: { notIn: ids } } });
    console.log(`comptes fictifs supprimés : ${users.count}`);

    // Les comptes conservés repartent à zéro : compteurs, adresses.
    await tx.address.deleteMany({ where: { userId: { in: ids } } });
    await tx.customerProfile.updateMany({
      where: { userId: { in: ids } },
      data: { ordersCount: 0, totalSpent: 0, loyaltyPoints: 0, cancelledOrders: 0, lastOrderAt: null },
    });
    await tx.driverProfile.updateMany({
      where: { userId: { in: ids } },
      data: {
        completedDeliveries: 0,
        cancelledDeliveries: 0,
        totalDistanceMeters: 0,
        totalDeliveryMinutes: 0,
        rating: null,
        isOnline: false,
        isAvailable: false,
        lastLatitude: null,
        lastLongitude: null,
        lastPositionAt: null,
      },
    });

    // Les plats gardent leur fiche, mais plus aucune note ni compteur
    // hérité de commandes qui n'existent plus.
    await tx.menuItem.updateMany({ data: { rating: null, reviewCount: 0, ordersCount: 0 } });
  });

  const restants = await prisma.user.findMany({ select: { email: true, role: true }, orderBy: { role: 'asc' } });
  console.log('comptes restants :');
  for (const u of restants) console.log('  ', u.role.padEnd(12), u.email);
}

main()
  .catch((error) => {
    console.error('ÉCHEC — rien n’a été modifié :', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
