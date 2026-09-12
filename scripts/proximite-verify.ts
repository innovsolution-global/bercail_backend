/**
 * Vérification du routage par proximité, contre la vraie base.
 *
 *     npm run proximite:verify
 *
 * Le test unitaire de `RestaurantRouter` prouve que l'arithmétique est
 * juste sur des maisons inventées. Il ne dit rien de **vos** maisons : si
 * l'une d'elles n'a pas de coordonnées, si deux se recouvrent, ou si vos
 * clients sont tous rattachés à la même parce qu'aucune adresse n'est
 * localisée. C'est ce que ce script regarde.
 *
 * Il ne modifie rien. Il lit, calcule et raconte.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { distanceKm, isValidCoordinates } from '../src/common/utils/geo.util';

const prisma = new PrismaClient();

/** Quelques points de Conakry, pour éprouver le routage là où il compte. */
const REPERES: { nom: string; latitude: number; longitude: number }[] = [
  { nom: 'Kipé', latitude: 9.6392, longitude: -13.6222 },
  { nom: 'Ratoma (Kaporo)', latitude: 9.6167, longitude: -13.6333 },
  { nom: 'Matam', latitude: 9.5303, longitude: -13.6836 },
  { nom: 'Kaloum (centre)', latitude: 9.5092, longitude: -13.7122 },
  { nom: 'Dixinn', latitude: 9.5450, longitude: -13.6800 },
  { nom: 'Matoto (aéroport)', latitude: 9.5769, longitude: -13.6119 },
];

type Maison = { id: string; code: string; name: string; latitude: number; longitude: number };

/** Reproduit la décision de `RestaurantRouter.nearestTo`. */
function plusProche(
  point: { latitude: number; longitude: number },
  maisons: Maison[],
): { maison: Maison; km: number } | null {
  if (maisons.length === 0) return null;

  let choisie = maisons[0];
  let courte = distanceKm(point, choisie);

  for (const maison of maisons.slice(1)) {
    const d = distanceKm(point, maison);
    if (d < courte) {
      courte = d;
      choisie = maison;
    }
  }

  return { maison: choisie, km: courte };
}

async function main(): Promise<void> {
  let echecs = 0;
  const verifie = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) echecs += 1;
  };

  // ── Les maisons ────────────────────────────────────────────────────
  const toutes = await prisma.restaurant.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, code: true, name: true, district: true, latitude: true, longitude: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log('── Établissements ──');
  const situees: Maison[] = [];
  for (const m of toutes) {
    const ok = isValidCoordinates({ latitude: m.latitude, longitude: m.longitude });
    console.log(
      `  ${m.code.padEnd(6)} ${m.name.padEnd(22)} ${String(m.district ?? '').padEnd(10)} ` +
        (ok ? `${m.latitude}, ${m.longitude}` : '⚠ SANS COORDONNÉES'),
    );
    if (ok) {
      situees.push({ ...m, latitude: m.latitude!, longitude: m.longitude! });
    }
  }

  console.log('');
  /*
   * Une maison sans coordonnées est invisible au routage : elle ne sera
   * jamais choisie, quelle que soit la proximité. Le client le plus proche
   * d'elle sera servi par une autre, à l'autre bout de la ville.
   */
  verifie(
    'toutes les maisons ouvertes sont localisées',
    situees.length === toutes.length,
    situees.length === toutes.length
      ? ''
      : `${toutes.length - situees.length} sans coordonnées, donc jamais choisie(s)`,
  );

  // Deux maisons au même endroit : le routage devient un tirage au sort.
  for (let i = 0; i < situees.length; i += 1) {
    for (let j = i + 1; j < situees.length; j += 1) {
      const d = distanceKm(situees[i], situees[j]);
      if (d < 0.5) {
        verifie(
          `${situees[i].code} et ${situees[j].code} sont distinctes`,
          false,
          `${(d * 1000).toFixed(0)} m l'une de l'autre : le choix devient arbitraire`,
        );
      }
    }
  }

  if (situees.length === 0) {
    console.log('\n❌ Aucune maison localisée : le routage retombe toujours sur la plus ancienne.');
    process.exitCode = 1;
    return;
  }

  // ── Le routage, vu de quelques points de la ville ───────────────────
  console.log('\n── Qui sert, depuis où ──');
  for (const repere of REPERES) {
    const r = plusProche(repere, situees);
    console.log(`  ${repere.nom.padEnd(20)} → ${r!.maison.code.padEnd(6)} (${r!.km.toFixed(1)} km)`);
  }

  // ── Les clients ────────────────────────────────────────────────────
  const clients = await prisma.user.findMany({
    where: { role: 'CUSTOMER', deletedAt: null },
    select: {
      email: true,
      addresses: {
        where: { deletedAt: null, latitude: { not: null }, longitude: { not: null } },
        select: { latitude: true, longitude: true },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        take: 1,
      },
    },
  });

  const parMaison = new Map<string, number>();
  let sansPoint = 0;

  for (const client of clients) {
    const adresse = client.addresses[0];
    if (!adresse) {
      sansPoint += 1;
      continue;
    }
    const r = plusProche(
      { latitude: adresse.latitude!, longitude: adresse.longitude! },
      situees,
    );
    const code = r!.maison.code;
    parMaison.set(code, (parMaison.get(code) ?? 0) + 1);
  }

  console.log('\n── Répartition des clients ──');
  for (const maison of situees) {
    console.log(`  ${maison.code.padEnd(6)} ${parMaison.get(maison.code) ?? 0} client(s)`);
  }
  console.log(
    `  ${'aucune'.padEnd(6)} ${sansPoint} client(s) sans adresse localisée ` +
      '→ servis par la plus ancienne',
  );

  /*
   * Le repli n'est pas une panne, mais s'il concerne tout le monde, le
   * routage par proximité ne sert à rien : personne n'est situé, et
   * l'enseigne se comporte comme si elle n'avait qu'une adresse.
   */
  verifie(
    'une part des clients est localisable',
    clients.length === 0 || sansPoint < clients.length,
    sansPoint === clients.length
      ? 'aucune adresse localisée : le routage retombe toujours sur la plus ancienne'
      : '',
  );

  // ── Les commandes déjà passées ─────────────────────────────────────
  /*
   * La maison d'une commande vient de son **panier**, pas de l'adresse de
   * livraison : on commande chez quelqu'un, puis on se fait livrer où l'on
   * veut. Un écart n'est donc pas une anomalie — mais un écart massif dit
   * que les clients sont servis par la mauvaise carte.
   */
  const commandes = await prisma.order.findMany({
    where: { channel: 'ONLINE', deletedAt: null, address: { isNot: null } },
    select: {
      reference: true,
      restaurantId: true,
      address: { select: { latitude: true, longitude: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const codeParId = new Map(situees.map((m) => [m.id, m.code]));
  let alignees = 0;
  let ecarts = 0;
  const exemples: string[] = [];

  for (const commande of commandes) {
    const a = commande.address;
    if (!isValidCoordinates({ latitude: a?.latitude, longitude: a?.longitude })) continue;

    const r = plusProche({ latitude: a!.latitude!, longitude: a!.longitude! }, situees);
    const recue = codeParId.get(commande.restaurantId) ?? '?';

    if (r!.maison.code === recue) {
      alignees += 1;
    } else {
      ecarts += 1;
      if (exemples.length < 5) {
        exemples.push(
          `${commande.reference} reçue par ${recue}, livrée à ${r!.km.toFixed(1)} km de ${r!.maison.code}`,
        );
      }
    }
  }

  console.log('\n── Commandes en ligne (200 dernières localisées) ──');
  console.log(`  ${alignees} servie(s) par la maison la plus proche de l'adresse`);
  console.log(`  ${ecarts} écart(s) — normal si le client a commandé sur une autre carte`);
  for (const exemple of exemples) console.log(`    · ${exemple}`);

  console.log(
    echecs === 0
      ? '\n✅ Le routage par proximité est exploitable.'
      : `\n❌ ${echecs} problème(s) : le routage ne peut pas faire son travail.`,
  );
  process.exitCode = echecs === 0 ? 0 : 1;
}

main()
  .catch((erreur) => {
    console.error('❌', erreur);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
