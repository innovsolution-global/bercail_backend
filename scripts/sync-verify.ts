/**
 * Vérification de bout en bout de la synchronisation.
 *
 *     npm run sync:verify
 *
 * Une écriture faite sur le serveur du restaurant doit se retrouver en
 * ligne, une seule fois, sans repartir en boucle. Le script écrit puis
 * nettoie derrière lui : il est sans effet durable sur les données.
 *
 * Il suppose un second jeu de tables jouant le nœud en ligne :
 *
 *     CREATE SCHEMA IF NOT EXISTS cloud;
 *     DATABASE_URL="...?schema=cloud" npx prisma migrate deploy
 */
import { PrismaClient } from '@prisma/client';
import { SyncApplyService } from '../src/sync/sync-apply.service';
import type { SyncChange } from '../src/sync/sync.contract';

const localUrl = process.env.DATABASE_URL!;
const cloudUrl = localUrl.replace('schema=public', 'schema=cloud');

const local = new PrismaClient({ datasources: { db: { url: localUrl } } });
const cloud = new PrismaClient({ datasources: { db: { url: cloudUrl } } });

/** Le service attend un PrismaService : seules ces méthodes lui servent. */
function asService(client: PrismaClient) {
  return Object.assign(client, {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => client.$transaction(fn as never),
  });
}

async function main() {
  const applier = new SyncApplyService(asService(cloud) as never);
  let failures = 0;
  const check = (label: string, ok: boolean) => {
    console.log(`${ok ? '✅' : '❌'} ${label}`);
    if (!ok) failures += 1;
  };

  // ---- 1. Une écriture sur le serveur local est journalisée ----
  const supplier = await local.supplier.create({
    data: { name: `Essai synchro ${Date.now()}`, phone: '622334455' },
  });
  const expense = await local.expense.create({
    data: {
      reference: `DEP-E2E-${Date.now()}`,
      label: 'Facture EDG — essai',
      category: 'ELECTRICITE',
      amount: 450_000,
      supplierId: supplier.id,
    },
  });

  const outbox = await local.syncOutbox.findMany({
    where: { entityId: { in: [supplier.id, expense.id] } },
    orderBy: { occurredAt: 'asc' },
  });
  check(`les 2 écritures sont journalisées (${outbox.length})`, outbox.length === 2);

  const changes: SyncChange[] = outbox.map((row) => ({
    id: row.id,
    origin: row.origin,
    entity: row.entity,
    entityId: row.entityId,
    operation: row.operation,
    payload: row.payload as Record<string, unknown>,
    occurredAt: row.occurredAt.toISOString(),
  }));

  // ---- 2. Le nœud en ligne les applique ----
  const first = await applier.apply(changes, 'CLOUD');
  check(`le pair accepte les 2 écritures (${first.accepted.length})`, first.accepted.length === 2);

  const copied = await cloud.expense.findUnique({ where: { id: expense.id } });
  check('la dépense existe en ligne', copied?.amount === 450_000);
  check('le fournisseur aussi (ordre des dépendances respecté)', Boolean(await cloud.supplier.findUnique({ where: { id: supplier.id } })));

  // ---- 3. L'écriture appliquée ne repart pas ----
  const echo = await cloud.syncOutbox.count({ where: { entityId: expense.id } });
  check('aucun écho : le pair ne renverra pas cette écriture', echo === 0);

  // ---- 4. Rejouer le lot ne double rien ----
  const second = await applier.apply(changes, 'CLOUD');
  check(`le rejeu est accepté sans réécrire (${second.accepted.length})`, second.accepted.length === 2);

  const total = await cloud.expense.count({ where: { id: expense.id } });
  check('la dépense n’existe qu’une fois après rejeu', total === 1);

  // ---- 5. Une entité appartenant au nœud receveur est refusée ----
  const asLocalNode = await applier.apply(
    [{ ...changes[1], id: `${changes[1].id}-bis` }],
    'LOCAL',
  );
  check(
    'une dépense envoyée au nœud local est mise de côté',
    asLocalNode.accepted.length === 0 && asLocalNode.conflicted.length === 1,
  );

  // ---- Ménage ----
  for (const client of [local, cloud]) {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.sync_apply = 'on'`);
      await tx.expense.deleteMany({ where: { id: expense.id } });
      await tx.supplier.deleteMany({ where: { id: supplier.id } });
    });
  }
  await local.syncOutbox.deleteMany({ where: { entityId: { in: [supplier.id, expense.id] } } });
  await cloud.syncApplied.deleteMany({ where: { entityId: { in: [supplier.id, expense.id] } } });
  await cloud.syncConflict.deleteMany({ where: { entityId: expense.id } });

  console.log(failures === 0 ? '\n✅ Le circuit complet fonctionne.' : `\n❌ ${failures} vérification(s) en échec.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('❌', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await local.$disconnect();
    await cloud.$disconnect();
  });
