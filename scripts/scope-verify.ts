/**
 * Vérification du cloisonnement par établissement.
 *
 *     npm run scope:verify
 *
 * Crée deux restaurants et une donnée dans chacun, puis contrôle qu'un
 * compte rattaché à l'un ne voit jamais celle de l'autre — par la liste,
 * par le compteur, ni même en demandant l'identifiant exact.
 *
 * Le script nettoie derrière lui : il est sans effet durable.
 */
import { PrismaClient } from '@prisma/client';
import { restaurantContext } from '../src/common/context/restaurant-context';
import { withRestaurantScope } from '../src/database/restaurant-scope.extension';

const prisma = withRestaurantScope(new PrismaClient()) as PrismaClient;

async function main() {
  let echecs = 0;
  const verifie = (label: string, ok: boolean) => {
    console.log(`${ok ? '✅' : '❌'} ${label}`);
    if (!ok) echecs += 1;
  };

  const marque = Date.now();

  // Hors requête : aucun cloisonnement, on peut préparer le terrain.
  const [alpha, beta] = await Promise.all([
    prisma.restaurant.create({
      data: {
        code: `T1${marque}`.slice(0, 12), name: 'Test Alpha', phone: '1', email: `a${marque}@t.gn`,
        address: 'a', latitude: 9.5, longitude: -13.7,
      },
    }),
    prisma.restaurant.create({
      data: {
        code: `T2${marque}`.slice(0, 12), name: 'Test Beta', phone: '2', email: `b${marque}@t.gn`,
        address: 'b', latitude: 9.6, longitude: -13.8,
      },
    }),
  ]);

  const depenseAlpha = await prisma.expense.create({
    data: {
      restaurantId: alpha.id, reference: `T-A-${marque}`, label: 'Facture Alpha',
      category: 'ELECTRICITE', amount: 100_000,
    },
  });
  const depenseBeta = await prisma.expense.create({
    data: {
      restaurantId: beta.id, reference: `T-B-${marque}`, label: 'Facture Beta',
      category: 'ELECTRICITE', amount: 200_000,
    },
  });

  // ---- Dans le périmètre d'Alpha ----
  await restaurantContext.run({ restaurantId: alpha.id, unrestricted: false }, async () => {
    const liste = await prisma.expense.findMany({ where: { reference: { startsWith: 'T-' } } });
    verifie(
      `la liste ne montre que les dépenses d'Alpha (${liste.length})`,
      liste.length === 1 && liste[0].id === depenseAlpha.id,
    );

    const total = await prisma.expense.count({ where: { reference: { startsWith: 'T-' } } });
    verifie('le compteur ne compte que celles d’Alpha', total === 1);

    const somme = await prisma.expense.aggregate({
      _sum: { amount: true },
      where: { reference: { startsWith: 'T-' } },
    });
    verifie('la somme ignore le montant de Beta', somme._sum.amount === 100_000);

    // Le cas qui compte : connaître l'identifiant exact ne suffit pas.
    const volee = await prisma.expense.findUnique({ where: { id: depenseBeta.id } });
    verifie('une dépense de Beta reste introuvable, même par son identifiant', volee === null);

    const sienne = await prisma.expense.findUnique({ where: { id: depenseAlpha.id } });
    verifie('la sienne, elle, se lit normalement', sienne?.id === depenseAlpha.id);

    // Une création sans établissement désigné reçoit celui du périmètre.
    const creee = await prisma.expense.create({
      data: { reference: `T-C-${marque}`, label: 'Sans établissement', category: 'EAU', amount: 1 },
    } as never);
    verifie("une création hérite de l'établissement du périmètre", creee.restaurantId === alpha.id);
    await prisma.expense.deleteMany({ where: { id: creee.id } });
  });

  // ---- Le propriétaire voit tout ----
  await restaurantContext.unscoped(async () => {
    const toutes = await prisma.expense.findMany({ where: { reference: { startsWith: 'T-' } } });
    verifie(`le propriétaire voit les deux établissements (${toutes.length})`, toutes.length === 2);
  });

  // ---- Ménage ----
  await prisma.expense.deleteMany({ where: { reference: { startsWith: `T-` , endsWith: String(marque) } } });
  await prisma.restaurant.deleteMany({ where: { id: { in: [alpha.id, beta.id] } } });

  console.log(echecs === 0 ? '\n✅ Le cloisonnement tient.' : `\n❌ ${echecs} fuite(s) détectée(s).`);
  process.exitCode = echecs === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('❌', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
