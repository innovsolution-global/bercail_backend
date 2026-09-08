import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncNode, SyncOperation } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  APPEND_ONLY_ENTITIES,
  ENTITY_MODELS,
  ENTITY_OWNERSHIP,
  isSynchronised,
  orderChanges,
  type SyncChange,
  type SyncPushResponse,
} from './sync.contract';

/** Résultat de l'examen d'une écriture avant de l'appliquer. */
type Verdict = { apply: true } | { apply: false; reason: string; existing?: unknown };

/**
 * Application des écritures reçues du nœud pair.
 *
 * Trois garanties, dans cet ordre d'importance :
 *
 *  1. **Rejouer est sans effet.** Chaque écriture porte l'identifiant que
 *     l'émetteur lui a donné ; le récepteur retient ce qu'il a appliqué. Un
 *     lot renvoyé parce que la réponse s'est perdue n'écrit rien de plus —
 *     une vente ne peut pas être comptée deux fois.
 *
 *  2. **On n'écrase jamais en silence.** Une écriture qui contredirait une
 *     donnée plus récente est mise de côté dans le journal des conflits.
 *     Sur de l'argent, une alerte vaut mieux qu'un écrasement discret.
 *
 *  3. **L'écriture appliquée ne repart pas.** Le déclencheur PostgreSQL
 *     reconnaît une écriture de synchronisation et ne la journalise pas,
 *     sans quoi les deux serveurs se renverraient les mêmes lignes sans fin.
 */
@Injectable()
export class SyncApplyService {
  private readonly logger = new Logger(SyncApplyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Applique un lot et renvoie ce qui a été accepté, ce qui a été mis de
   * côté.
   *
   * Chaque écriture est appliquée dans sa propre transaction : une ligne
   * problématique ne doit pas faire échouer les quarante autres, surtout
   * après une coupure où le lot rattrape plusieurs heures de service.
   */
  async apply(changes: SyncChange[], selfNode: SyncNode): Promise<SyncPushResponse> {
    const accepted: string[] = [];
    const conflicted: { id: string; reason: string }[] = [];
    const touchedOrders = new Set<string>();

    for (const change of orderChanges(changes)) {
      try {
        const outcome = await this.applyOne(change, selfNode);

        if (outcome.applied) accepted.push(change.id);
        else conflicted.push({ id: change.id, reason: outcome.reason });

        if (outcome.applied && change.entity === 'OrderStatusHistory') {
          const orderId = change.payload.orderId;
          if (typeof orderId === 'string') touchedOrders.add(orderId);
        }
      } catch (error) {
        // Une écriture impossible ne bloque pas le lot : elle est signalée
        // et l'échange continue.
        const reason = (error as Error).message;
        this.logger.error(`Écriture ${change.entity}/${change.entityId} refusée : ${reason}`);
        await this.recordConflict(change, reason, null);
        conflicted.push({ id: change.id, reason });
      }
    }

    for (const orderId of touchedOrders) {
      await this.recomputeOrderStatus(orderId);
    }

    return { accepted, conflicted };
  }

  /* ------------------------------------------------------------------ */
  /* Une écriture                                                        */
  /* ------------------------------------------------------------------ */

  private async applyOne(
    change: SyncChange,
    selfNode: SyncNode,
  ): Promise<{ applied: true } | { applied: false; reason: string }> {
    if (!isSynchronised(change.entity)) {
      return { applied: false, reason: `Entité « ${change.entity} » hors du périmètre.` };
    }

    // Déjà vue : on répond « acceptée » sans rien réécrire. C'est ce qui
    // rend un renvoi de lot inoffensif.
    const known = await this.prisma.syncApplied.findUnique({ where: { id: change.id } });
    if (known) return { applied: true };

    const verdict = await this.judge(change, selfNode);
    if (!verdict.apply) {
      await this.recordConflict(change, verdict.reason, verdict.existing ?? null);
      return { applied: false, reason: verdict.reason };
    }

    await this.write(change);
    return { applied: true };
  }

  /**
   * Décide si une écriture peut s'appliquer.
   *
   * La règle de propriété fait presque tout le travail : quand une donnée
   * n'a qu'un écrivain, ce qu'il envoie fait foi. Le reste est traité au
   * cas par cas, et le doute penche toujours vers le conflit.
   */
  private async judge(change: SyncChange, selfNode: SyncNode): Promise<Verdict> {
    const ownership = ENTITY_OWNERSHIP[change.entity];

    // Ajout seul : la ligne existe ou elle n'existe pas. Rien à arbitrer.
    if (APPEND_ONLY_ENTITIES.has(change.entity)) return { apply: true };

    if (ownership !== 'SHARED') {
      // Le pair nous envoie une entité dont nous sommes propriétaires :
      // il n'aurait pas dû l'écrire. On refuse plutôt que d'accepter une
      // donnée qui contredirait la nôtre.
      if (ownership === selfNode) {
        return {
          apply: false,
          reason: `« ${change.entity} » appartient au nœud ${selfNode} : le pair n'a pas à l'écrire.`,
        };
      }
      // Le propriétaire parle : sa version fait foi.
      return { apply: true };
    }

    // Entité partagée : on n'écrase pas une version plus récente.
    const existing = await this.readExisting(change);
    if (!existing) return { apply: true };

    const localUpdatedAt = this.timestampOf(existing);
    if (localUpdatedAt && localUpdatedAt.getTime() > new Date(change.occurredAt).getTime()) {
      return {
        apply: false,
        reason: 'Une version plus récente existe déjà sur ce serveur.',
        existing,
      };
    }

    return { apply: true };
  }

  /** Écrit la ligne, en marquant la transaction comme venant d'une synchro. */
  private async write(change: SyncChange): Promise<void> {
    const model = ENTITY_MODELS[change.entity];

    await this.prisma.transaction(async (tx) => {
      // Le déclencheur lit ce réglage : sans lui, l'écriture repartirait
      // vers le pair, qui nous la renverrait, indéfiniment.
      await tx.$executeRawUnsafe(`SET LOCAL app.sync_apply = 'on'`);

      const delegate = this.delegate(tx, model);
      const data = this.toPrismaData(change.payload);

      if (change.operation === SyncOperation.DELETE) {
        // La ligne a pu déjà disparaître : l'absence n'est pas une erreur.
        await delegate.deleteMany({ where: { id: change.entityId } });
      } else {
        await delegate.upsert({
          where: { id: change.entityId },
          create: data,
          update: data,
        });
      }

      await tx.syncApplied.create({
        data: {
          id: change.id,
          origin: change.origin,
          entity: change.entity,
          entityId: change.entityId,
        },
      });
    });
  }

  /**
   * Recalcule le statut d'une commande depuis son historique.
   *
   * L'historique est en ajout seul : les deux serveurs y écrivent sans se
   * contredire. Le statut, lui, est une conséquence — on le déduit du
   * dernier événement plutôt que de le répliquer, ce qui évite qu'une
   * commande recule parce qu'un lot est arrivé dans le désordre.
   */
  private async recomputeOrderStatus(orderId: string): Promise<void> {
    try {
      const [order, latest] = await Promise.all([
        this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } }),
        this.prisma.orderStatusHistory.findFirst({
          where: { orderId },
          orderBy: { createdAt: 'desc' },
          select: { status: true },
        }),
      ]);

      if (!order || !latest || order.status === latest.status) return;

      await this.prisma.transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.sync_apply = 'on'`);
        await tx.order.update({ where: { id: orderId }, data: { status: latest.status } });
      });
    } catch (error) {
      this.logger.error(
        `Statut de la commande ${orderId} non recalculé : ${(error as Error).message}`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  private async readExisting(change: SyncChange): Promise<Record<string, unknown> | null> {
    const delegate = this.delegate(this.prisma, ENTITY_MODELS[change.entity]);
    return (await delegate.findUnique({ where: { id: change.entityId } })) as Record<
      string,
      unknown
    > | null;
  }

  /** `updatedAt` si le modèle en a un, `createdAt` sinon. */
  private timestampOf(row: Record<string, unknown>): Date | null {
    const value = row.updatedAt ?? row.createdAt;
    return value instanceof Date ? value : null;
  }

  /**
   * Accès dynamique au modèle Prisma.
   *
   * Le nom vient de la table de correspondance, jamais du réseau : une
   * entité inconnue est écartée bien avant d'arriver ici.
   */
  private delegate(
    client: PrismaService | Prisma.TransactionClient,
    model: string,
  ): {
    findUnique: (args: unknown) => Promise<unknown>;
    upsert: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  } {
    const delegate = (client as unknown as Record<string, unknown>)[model];
    if (!delegate) throw new Error(`Modèle Prisma « ${model} » introuvable.`);
    return delegate as ReturnType<SyncApplyService['delegate']>;
  }

  /**
   * Remet la charge utile au format attendu par Prisma.
   *
   * Le JSON du réseau ne connaît ni les dates ni les décimales : les
   * chaînes ISO redeviennent des `Date`, faute de quoi Prisma refuse
   * l'écriture.
   */
  private toPrismaData(payload: Record<string, unknown>): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      data[key] = typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value;
    }

    return data;
  }

  private async recordConflict(
    change: SyncChange,
    reason: string,
    existing: unknown,
  ): Promise<void> {
    try {
      await this.prisma.syncConflict.create({
        data: {
          entity: change.entity,
          entityId: change.entityId,
          origin: change.origin,
          incoming: change.payload as Prisma.InputJsonValue,
          existing: (existing ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          reason,
        },
      });
    } catch (error) {
      this.logger.error(`Conflit non journalisé : ${(error as Error).message}`);
    }
  }
}

/** `2026-09-08T11:32:13.000Z` — le format que produit `to_jsonb` sur un timestamp. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
