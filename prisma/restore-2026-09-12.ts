/* eslint-disable no-console */
/**
 * Remise en état du 12 septembre 2026.
 *
 * La base de développement a été vidée par un `prisma migrate dev` lancé
 * pour ajouter les avis : l'outil a détecté une dérive entre l'historique
 * des migrations (inexistant, la base ayant toujours été gérée par
 * `db push`) et le schéma, et a réinitialisé le schéma `public` avant
 * d'échouer sur la base fantôme. Le seed a été rejoué ; ce script recrée
 * ce que le seed ne connaît pas et que le propriétaire avait créé à la
 * main :
 *
 *  • l'établissement « Le Bercail — Kipé » (code BRC2), avec ses
 *    horaires, ses frais, sa position, son gérant, et une copie de la
 *    carte de Kaloum — chaque maison a la sienne ;
 *  • le compte client alphonselouainnov@gmail.com ;
 *  • le compte gérant alphaiemail01@gmail.com, sur Kaloum.
 *
 * Les mots de passe sont provisoires et doivent être changés à la
 * première connexion. Les commandes passées, les adresses et la photo de
 * profil ne sont pas récupérables.
 *
 *   npx ts-node --transpile-only prisma/restore-2026-09-12.ts
 */
import { AccountStatus, PrismaClient, Role, VehicleType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const PROVISOIRE = 'Bercail@2026';

async function main() {
  const kaloum = await prisma.restaurant.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const superAdmin = await prisma.user.findFirstOrThrow({ where: { role: Role.SUPER_ADMIN } });
  const hash = bcrypt.hashSync(PROVISOIRE, 10);

  // ── Kipé ──────────────────────────────────────────────────────────
  let kipe = await prisma.restaurant.findUnique({ where: { code: 'BRC2' } });
  if (!kipe) {
    kipe = await prisma.restaurant.create({
      data: {
        code: 'BRC2',
        name: 'Le Bercail — Kipé',
        tagline: kaloum.tagline,
        description: kaloum.description,
        phone: '+224620049886',
        email: 'kipe@lebercail.gn',
        address: 'Kipé, carrefour Constantin',
        district: 'Ratoma',
        city: 'Conakry',
        latitude: 9.639167,
        longitude: -13.622222,
        deliveryFee: 18_000,
        minimumOrderAmount: 50_000,
        averagePreparationMinutes: kaloum.averagePreparationMinutes,
        averageDeliveryMinutes: kaloum.averageDeliveryMinutes,
        deliveryZones: ['Ratoma', 'Kipé', 'Nongo', 'Lambanyi'],
        isOpen: true,
        isActive: true,
      },
    });

    // Les horaires de Kaloum, tels quels.
    const horaires = await prisma.openingHour.findMany({ where: { restaurantId: kaloum.id } });
    for (const h of horaires) {
      await prisma.openingHour.create({
        data: {
          restaurantId: kipe.id,
          weekday: h.weekday,
          opensAt: h.opensAt,
          closesAt: h.closesAt,
          isClosed: h.isClosed,
        },
      });
    }

    // Plus de copie de la carte : depuis le 14 septembre 2026 elle est
    // commune à toutes les maisons.
    console.log('Kipé recréé :', kipe.id);
  } else {
    console.log('Kipé existe déjà');
  }

  // ── Le gérant de Kipé ──────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: 'gerant.brc2@lebercail.gn' },
    update: {},
    create: {
      restaurantId: kipe.id,
      firstName: 'Gérant',
      lastName: 'Kipé',
      email: 'gerant.brc2@lebercail.gn',
      phone: '+224620049887',
      passwordHash: hash,
      role: Role.ADMIN,
      status: AccountStatus.ACTIVE,
      createdById: superAdmin.id,
      mustChangePassword: true,
    },
  });
  console.log('gérant de Kipé : gerant.brc2@lebercail.gn');

  // ── Les comptes du propriétaire ────────────────────────────────────
  await prisma.user.upsert({
    where: { email: 'alphonselouainnov@gmail.com' },
    update: {},
    create: {
      firstName: 'Alphonse',
      lastName: 'Loua',
      email: 'alphonselouainnov@gmail.com',
      phone: '629205212',
      passwordHash: hash,
      role: Role.CUSTOMER,
      status: AccountStatus.ACTIVE,
      mustChangePassword: true,
      customerProfile: { create: {} },
    },
  });
  console.log('client : alphonselouainnov@gmail.com');

  await prisma.user.upsert({
    where: { email: 'alphaiemail01@gmail.com' },
    update: {},
    create: {
      restaurantId: kaloum.id,
      firstName: 'Alphonse',
      lastName: 'Loua',
      email: 'alphaiemail01@gmail.com',
      phone: '+224629205211',
      passwordHash: hash,
      role: Role.ADMIN,
      status: AccountStatus.ACTIVE,
      createdById: superAdmin.id,
      mustChangePassword: true,
    },
  });
  console.log('gérant Kaloum : alphaiemail01@gmail.com');

  // ── Le livreur d'essai du propriétaire ─────────────────────────────
  await prisma.user.upsert({
    where: { email: 'livreur.alphonse@lebercail.gn' },
    update: {},
    create: {
      restaurantId: kaloum.id,
      firstName: 'Alphonse',
      lastName: 'Loua',
      email: 'livreur.alphonse@lebercail.gn',
      phone: '629205210',
      passwordHash: hash,
      role: Role.DRIVER,
      status: AccountStatus.ACTIVE,
      createdById: superAdmin.id,
      mustChangePassword: true,
      driverProfile: {
        create: {
          driverCode: 'LIV-008',
          vehicleType: VehicleType.MOTO,
          plateNumber: 'RC-0012',
          zone: 'Ratoma',
        },
      },
    },
  });
  console.log('livreur : livreur.alphonse@lebercail.gn (LIV-008)');

  console.log(`\nMot de passe provisoire des quatre comptes : ${PROVISOIRE} (à changer à la première connexion)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
