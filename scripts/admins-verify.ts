/**
 * Vérification des accès du back-office notés dans `.env`.
 *
 *     npm run admins:verify           # contrôle en base
 *     npm run admins:verify -- --live # + connexion réelle et périmètre appliqué
 *
 * Un mot de passe consigné dans un fichier n'a de valeur que s'il ouvre
 * encore la porte. Celui-ci se démode en silence : quelqu'un change son
 * mot de passe, un compte est suspendu, un gérant est déplacé d'un
 * établissement à l'autre — et le fichier continue d'affirmer le
 * contraire.
 *
 * Par défaut le contrôle se fait **en base** : l'empreinte du mot de passe
 * est comparée, le rôle, l'état et le rattachement sont lus. Ni serveur ni
 * réseau, et surtout aucune tentative de connexion consommée — la route de
 * connexion est plafonnée à dix essais par tranche de cinq minutes, et un
 * contrôle qui déclenche lui-même la protection anti-force-brute ne vaut
 * rien.
 *
 * `--live` ajoute ce que la base ne peut pas dire : le périmètre
 * **réellement appliqué** par le serveur. Un rattachement correct en
 * colonne mais mal appliqué à la requête reste une fuite.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { compareSync } from 'bcryptjs';

const prisma = new PrismaClient();

type Compte = {
  libelle: string;
  prefixe: string;
  /** Code de l'établissement attendu ; `null` pour un compte non cloisonné. */
  etablissement: string | null;
  /**
   * Entrée du seed plutôt que relevé d'un compte en place : son absence
   * en base n'est pas une anomalie tant que le seed n'a pas été rejoué.
   */
  seedUniquement?: boolean;
};

const COMPTES: Compte[] = [
  { libelle: 'SUPER_ADMIN', prefixe: 'SUPER_ADMIN', etablissement: null, seedUniquement: true },
  { libelle: 'Gérant BRC', prefixe: 'ADMIN_BRC', etablissement: 'BRC' },
  { libelle: 'Gérant BRC2', prefixe: 'ADMIN_BRC2', etablissement: 'BRC2' },
];

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PREFIXE_API = process.env.API_PREFIX ?? 'api/v1';

/** Déplie l'enveloppe `{ data: … }` du contrat d'API. */
function contenu(charge: unknown): unknown {
  let valeur = charge;
  while (
    typeof valeur === 'object' &&
    valeur !== null &&
    'data' in (valeur as Record<string, unknown>)
  ) {
    valeur = (valeur as Record<string, unknown>).data;
  }
  return valeur;
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  let echecs = 0;
  let avertissements = 0;

  const verifie = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) echecs += 1;
  };

  const restaurants = await prisma.restaurant.findMany({ select: { id: true, code: true } });
  const codeParId = new Map(restaurants.map((r) => [r.id, r.code]));

  for (const compte of COMPTES) {
    const email = process.env[`${compte.prefixe}_EMAIL`];
    const motDePasse = process.env[`${compte.prefixe}_PASSWORD`];

    if (!email || !motDePasse) {
      verifie(`${compte.libelle} : accès non renseigné dans .env`, false);
      continue;
    }

    const utilisateur = await prisma.user.findUnique({
      where: { email },
      select: {
        email: true,
        role: true,
        status: true,
        restaurantId: true,
        passwordHash: true,
        deletedAt: true,
        mustChangePassword: true,
      },
    });

    if (!utilisateur || utilisateur.deletedAt) {
      if (compte.seedUniquement) {
        console.log(
          `⚠️  ${compte.libelle} (${email}) n'existe pas en base — attendu : ` +
            'ces lignes alimentent le seed, qui efface tout et n’a pas été rejoué.',
        );
        avertissements += 1;
      } else {
        verifie(`${compte.libelle} (${email})`, false, 'compte introuvable');
      }
      continue;
    }

    const motDePasseValide = compareSync(motDePasse, utilisateur.passwordHash);
    const sonEtablissement = utilisateur.restaurantId
      ? (codeParId.get(utilisateur.restaurantId) ?? '?')
      : null;

    const conforme =
      motDePasseValide &&
      utilisateur.status === 'ACTIVE' &&
      sonEtablissement === compte.etablissement;

    verifie(
      `${compte.libelle} (${email})`,
      conforme,
      [
        motDePasseValide ? null : 'mot de passe périmé',
        utilisateur.status === 'ACTIVE' ? null : `compte ${utilisateur.status}`,
        sonEtablissement === compte.etablissement
          ? null
          : `rattaché à ${sonEtablissement ?? 'aucun établissement'}, attendu ${compte.etablissement ?? 'aucun'}`,
      ]
        .filter(Boolean)
        .join(' · '),
    );

    // Un changement de mot de passe imposé rendra la valeur du fichier
    // caduque dès la première connexion.
    if (conforme && utilisateur.mustChangePassword) {
      console.log('   ⚠️  changement de mot de passe imposé : cette valeur ne survivra pas.');
      avertissements += 1;
    }
  }

  if (live) {
    console.log('\n── Périmètre réellement appliqué ──');
    for (const compte of COMPTES.filter((c) => !c.seedUniquement)) {
      const email = process.env[`${compte.prefixe}_EMAIL`];
      const motDePasse = process.env[`${compte.prefixe}_PASSWORD`];
      if (!email || !motDePasse) continue;

      const reponse = await fetch(`${API}/${PREFIXE_API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: motDePasse }),
      });

      if (reponse.status === 429) {
        console.log('⏳ Limiteur de débit atteint : dix connexions par cinq minutes.');
        console.log('   Rien n’a pu être vérifié ici ; le contrôle en base ci-dessus tient.');
        break;
      }

      if (!reponse.ok) {
        verifie(`${compte.libelle} se connecte`, false, `refusée (${reponse.status})`);
        continue;
      }

      const session = contenu(await reponse.json()) as { accessToken?: string };
      const jeton = session.accessToken;
      if (!jeton) {
        verifie(`${compte.libelle} reçoit un jeton`, false);
        continue;
      }

      const liste = await fetch(`${API}/${PREFIXE_API}/restaurants`, {
        headers: { Authorization: `Bearer ${jeton}` },
      });
      const vus = (contenu(await liste.json()) ?? []) as { code: string }[];
      const codes = Array.isArray(vus) ? vus.map((r) => r.code) : [];

      verifie(
        `${compte.libelle} ne voit que ${compte.etablissement}`,
        codes.length === 1 && codes[0] === compte.etablissement,
        `voit ${codes.join(', ') || 'aucun'}`,
      );
    }
  }

  console.log(
    echecs === 0
      ? `\n✅ Les accès notés dans .env décrivent la réalité.${avertissements > 0 ? ` (${avertissements} avertissement(s))` : ''}`
      : `\n❌ ${echecs} écart(s) — .env ne décrit plus la réalité.`,
  );
  if (!live) console.log('   (--live pour éprouver aussi le cloisonnement appliqué)');

  process.exitCode = echecs === 0 ? 0 : 1;
}

main()
  .catch((erreur) => {
    console.error('❌', erreur);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
