/**
 * Recalcule toutes les notes (maisons, livreurs, plats) depuis les avis.
 *
 *     npm run notes:recalculer
 *
 * À lancer après un changement de la règle d'affichage — le seuil d'avis,
 * par exemple — ou si une moyenne semble avoir dérivé. Les avis eux-mêmes
 * ne sont pas touchés : seules les moyennes qu'on en tire sont réécrites.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { MIN_REVIEWS_FOR_RATING, displayedRating } from '../src/common/utils/rating.util';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const maisons = await prisma.restaurant.findMany({ select: { id: true, name: true } });
  for (const maison of maisons) {
    const agg = await prisma.orderReview.aggregate({
      where: { restaurantId: maison.id },
      _avg: { restaurantRating: true },
      _count: { _all: true },
    });
    const rating = displayedRating(agg._avg.restaurantRating, agg._count._all);
    await prisma.restaurant.update({
      where: { id: maison.id },
      data: { rating, reviewCount: agg._count._all },
    });
    console.log(`maison   ${maison.name.padEnd(28)} ${agg._count._all} avis → ${rating ?? '—'}`);
  }

  const livreurs = await prisma.driverProfile.findMany({
    select: { id: true, user: { select: { firstName: true } } },
  });
  for (const livreur of livreurs) {
    const agg = await prisma.orderReview.aggregate({
      where: { driverId: livreur.id, driverRating: { not: null } },
      _avg: { driverRating: true },
      _count: { _all: true },
    });
    const rating = displayedRating(agg._avg.driverRating, agg._count._all);
    await prisma.driverProfile.update({ where: { id: livreur.id }, data: { rating } });
    console.log(
      `livreur  ${(livreur.user?.firstName ?? livreur.id).padEnd(28)} ${agg._count._all} avis → ${rating ?? '—'}`,
    );
  }

  const plats = await prisma.menuItem.findMany({ select: { id: true, name: true } });
  for (const plat of plats) {
    const agg = await prisma.orderItemReview.aggregate({
      where: { menuItemId: plat.id },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const rating = displayedRating(agg._avg.rating, agg._count._all);
    await prisma.menuItem.update({
      where: { id: plat.id },
      data: { rating, reviewCount: agg._count._all },
    });
    console.log(`plat     ${plat.name.padEnd(28)} ${agg._count._all} avis → ${rating ?? '—'}`);
  }

  console.log(`\nSeuil d'affichage : ${MIN_REVIEWS_FOR_RATING} avis.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
