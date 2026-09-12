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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { restaurantContext } from '../src/common/context/restaurant-context';
import { restaurantFilter } from '../src/common/context/restaurant-sql';
import { withRestaurantScope } from '../src/database/restaurant-scope.extension';

const prisma = withRestaurantScope(new PrismaClient()) as PrismaClient;

/**
 * Un gabarit SQL complet, dos d'apostrophes compris.
 *
 * `Prisma.sql` compte autant que `$queryRaw` : le journal unifié des
 * finances est un fragment de ce type, assemblé à part puis inséré dans
 * deux requêtes. Un oubli de filtre y passerait deux fois.
 */
const RAW_TEMPLATE = /(?:[$](?:query|execute)Raw|Prisma[.]sql)[^`]*`[^`]*`/g;

/** Tout ce qui n'est pas un identifiant SQL sépare deux mots. */
const SEPARATEURS = /[^a-z_]+/;

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

    /*
     * Le SQL ecrit a la main.
     *
     * C'est le trou que l'extension Prisma ne bouche pas : une requete
     * brute part telle quelle vers PostgreSQL. C'est par la qu'un
     * indicateur et sa courbe ont affiche deux chiffres differents sur le
     * meme ecran, le plus gros etant le faux.
     */
    const brut = await prisma.$queryRaw<{ somme: number }[]>`
      SELECT COALESCE(SUM(amount), 0)::int AS somme
      FROM expenses
      WHERE reference LIKE 'T-%'
        AND ${restaurantFilter()}
    `;
    verifie(
      `une requete SQL brute filtree ignore Beta (${brut[0]?.somme})`,
      Number(brut[0]?.somme) === 100_000,
    );

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

    // Hors perimetre, le meme fragment ne doit rien retrancher.
    const brut = await prisma.$queryRaw<{ somme: number }[]>`
      SELECT COALESCE(SUM(amount), 0)::int AS somme
      FROM expenses
      WHERE reference LIKE 'T-%'
        AND ${restaurantFilter()}
    `;
    verifie(
      `la meme requete brute cumule les deux (${brut[0]?.somme})`,
      Number(brut[0]?.somme) === 300_000,
    );
  });

  // ---- Aucune requete brute oubliee ----
  for (const [fichier, tables] of requetesBrutesSansFiltre()) {
    verifie(`${fichier} : requete brute sans filtre sur ${tables}`, false);
  }

  // ---- Ménage ----
  await prisma.expense.deleteMany({ where: { reference: { startsWith: `T-` , endsWith: String(marque) } } });
  await prisma.restaurant.deleteMany({ where: { id: { in: [alpha.id, beta.id] } } });

  console.log(echecs === 0 ? '\n✅ Le cloisonnement tient.' : `\n❌ ${echecs} fuite(s) détectée(s).`);
  process.exitCode = echecs === 0 ? 0 : 1;
}

/**
 * Recense les requêtes SQL brutes qui interrogent une table cloisonnée
 * sans filtre d'établissement.
 *
 * Un contrôle à l'exécution ne peut pas couvrir une requête qu'on n'a pas
 * pensé à appeler : celui-ci lit le code et ne laisse donc pas passer une
 * requête ajoutée demain. C'est la seule protection possible ici —
 * l'extension Prisma, elle, ne voit jamais une requête brute.
 */
function requetesBrutesSansFiltre(): [string, string][] {
  const TABLES_CLOISONNEES = [
    'orders', 'order_items', 'expenses', 'incomes', 'stock_items', 'stock_movements',
    'purchases', 'employees', 'promotions', 'menu_items', 'categories', 'suppliers',
    'deliveries',
  ];

  const oublis: [string, string][] = [];

  const parcourir = (dossier: string) => {
    for (const entree of readdirSync(dossier)) {
      const chemin = join(dossier, entree);
      if (statSync(chemin).isDirectory()) {
        parcourir(chemin);
        continue;
      }
      if (!entree.endsWith('.ts') || entree.endsWith('.spec.ts')) continue;
      // Le fichier qui définit le filtre interroge `orders` sans s'appeler
      // lui-même : c'est le seul faux positif, et il est attendu.
      if (entree === 'restaurant-sql.ts') continue;

      const source = readFileSync(chemin, 'utf8');

      // Chaque gabarit `$queryRaw` / `$executeRaw` jusqu'à son dos d'apostrophe final.
      for (const bloc of source.match(RAW_TEMPLATE) ?? []) {
        /*
         * Découpage en mots plutôt qu'expression régulière par table : une
         * table n'est interrogée que si son nom suit immédiatement `FROM`
         * ou `JOIN`, ce qu'une recherche de sous-chaîne confondrait avec
         * une simple mention en commentaire.
         */
        const mots = bloc.toLowerCase().split(SEPARATEURS);

        const touchees = TABLES_CLOISONNEES.filter((table) =>
          mots.some(
            (mot, index) =>
              mot === table && (mots[index - 1] === 'from' || mots[index - 1] === 'join'),
          ),
        );

        if (touchees.length > 0 && !bloc.includes('restaurantFilter')) {
          oublis.push([chemin.split(sep).join('/'), touchees.join(', ')]);
        }
      }
    }
  };

  parcourir(join(__dirname, '..', 'src'));
  return oublis;
}

main()
  .catch((error) => {
    console.error('❌', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
