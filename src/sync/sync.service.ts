import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SyncNode, SyncStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SyncApplyService } from './sync-apply.service';
import {
  peerOf,
  type SyncChange,
  type SyncPullResponse,
  type SyncPushResponse,
} from './sync.contract';

/**
 * Moteur de synchronisation.
 *
 * **C'est toujours le serveur du restaurant qui engage l'échange.** Il est
 * derrière la box de l'établissement, sans adresse joignable depuis
 * l'extérieur : le serveur en ligne ne peut pas l'appeler. À chaque cycle,
 * le nœud local pousse ce qu'il a écrit, puis tire ce qui a été écrit en
 * ligne.
 *
 * Une coupure n'est pas une panne : le journal s'accumule, et le premier
 * cycle qui repasse rattrape tout ce qui s'est vendu entre-temps.
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  private readonly enabled: boolean;
  private readonly node: SyncNode;
  private readonly peerUrl: string;
  private readonly secret: string;
  private readonly intervalSeconds: number;
  private readonly batchSize: number;

  /** Empêche deux cycles de se chevaucher si l'un traîne. */
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly applier: SyncApplyService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('sync.enabled') ?? false;
    this.node = (config.get<string>('sync.node') ?? 'LOCAL') as SyncNode;
    this.peerUrl = config.get<string>('sync.peerUrl') ?? '';
    this.secret = config.get<string>('sync.secret') ?? '';
    this.intervalSeconds = config.get<number>('sync.intervalSeconds') ?? 20;
    this.batchSize = config.get<number>('sync.batchSize') ?? 200;
  }

  /** Identité de ce serveur. Le corps d'une requête ne fait jamais foi. */
  get currentNode(): SyncNode {
    return this.node;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureState();

    if (!this.enabled) {
      this.logger.log('Synchronisation désactivée (SYNC_ENABLED absent).');
      return;
    }

    // Seul le nœud local démarre la boucle : le nœud en ligne se contente
    // de répondre.
    if (this.node !== SyncNode.LOCAL) {
      this.logger.log('Nœud en ligne : en attente des échanges du restaurant.');
      return;
    }

    if (!this.peerUrl || !this.secret) {
      this.logger.error(
        'Synchronisation active mais incomplète : SYNC_PEER_URL et SYNC_SECRET sont requis.',
      );
      return;
    }

    this.timer = setInterval(() => void this.cycle(), this.intervalSeconds * 1000);
    // `unref` : un cycle en attente ne doit pas retenir le processus à l'arrêt.
    this.timer.unref?.();
    this.logger.log(`Synchronisation active vers ${this.peerUrl}, toutes les ${this.intervalSeconds} s.`);
  }

  /* ------------------------------------------------------------------ */
  /* Cycle                                                               */
  /* ------------------------------------------------------------------ */

  /** Un aller-retour complet : pousser, puis tirer. */
  async cycle(): Promise<{ pushed: number; pulled: number; error?: string }> {
    if (this.running) return { pushed: 0, pulled: 0 };
    this.running = true;

    try {
      const pushed = await this.push();
      const pulled = await this.pull();
      await this.prisma.syncState.update({
        where: { id: 'sync' },
        data: { lastError: null },
      });
      return { pushed, pulled };
    } catch (error) {
      const message = (error as Error).message;
      // Une coupure réseau est le cas nominal, pas un incident : on la note
      // sans alarmer les journaux.
      this.logger.warn(`Échange impossible : ${message}`);
      await this.prisma.syncState.update({
        where: { id: 'sync' },
        data: { lastError: message },
      });
      return { pushed: 0, pulled: 0, error: message };
    } finally {
      this.running = false;
    }
  }

  /** Transmet les écritures en attente, par lots. */
  private async push(): Promise<number> {
    const pending = await this.prisma.syncOutbox.findMany({
      where: { status: { in: [SyncStatus.PENDING, SyncStatus.FAILED] }, origin: this.node },
      orderBy: { occurredAt: 'asc' },
      take: this.batchSize,
    });

    if (pending.length === 0) return 0;

    const changes: SyncChange[] = pending.map((row) => ({
      id: row.id,
      origin: row.origin,
      entity: row.entity,
      entityId: row.entityId,
      operation: row.operation,
      payload: row.payload as Record<string, unknown>,
      occurredAt: row.occurredAt.toISOString(),
    }));

    const response = await this.call<SyncPushResponse>('POST', '/sync/push', {
      node: this.node,
      changes,
    });

    const accepted = new Set(response.accepted);
    const now = new Date();

    // Une écriture mise de côté par le pair ne repart pas indéfiniment :
    // elle est marquée en échec, avec son motif, et attend un examen.
    for (const row of pending) {
      const conflict = response.conflicted.find((entry) => entry.id === row.id);

      await this.prisma.syncOutbox.update({
        where: { id: row.id },
        data: accepted.has(row.id)
          ? { status: SyncStatus.SENT, syncedAt: now, lastError: null }
          : {
              status: SyncStatus.FAILED,
              attempts: { increment: 1 },
              lastError: conflict?.reason ?? 'Refusée par le nœud pair.',
            },
      });
    }

    await this.prisma.syncState.update({
      where: { id: 'sync' },
      data: { lastPushAt: now, pushedCount: { increment: accepted.size } },
    });

    if (response.conflicted.length > 0) {
      this.logger.warn(`${response.conflicted.length} écriture(s) mises de côté par le pair.`);
    }

    return accepted.size;
  }

  /** Récupère ce que le pair a écrit depuis le dernier curseur. */
  private async pull(): Promise<number> {
    const state = await this.prisma.syncState.findUnique({ where: { id: 'sync' } });
    const since = state?.cursor?.toISOString() ?? '';

    const response = await this.call<SyncPullResponse>(
      'GET',
      `/sync/pull?since=${encodeURIComponent(since)}&limit=${this.batchSize}`,
    );

    if (response.changes.length === 0) {
      await this.prisma.syncState.update({
        where: { id: 'sync' },
        data: { lastPullAt: new Date() },
      });
      return 0;
    }

    const outcome = await this.applier.apply(response.changes, this.node);

    // Le curseur n'avance que sur ce qui a été traité : une écriture mise
    // de côté a laissé une trace dans le journal des conflits, la rejouer
    // ne servirait à rien.
    await this.prisma.syncState.update({
      where: { id: 'sync' },
      data: {
        cursor: response.cursor ? new Date(response.cursor) : state?.cursor,
        lastPullAt: new Date(),
        pulledCount: { increment: outcome.accepted.length },
      },
    });

    return outcome.accepted.length;
  }

  /* ------------------------------------------------------------------ */
  /* Lecture pour le pair                                                */
  /* ------------------------------------------------------------------ */

  /** Écritures de ce nœud postérieures au curseur du pair. */
  async changesSince(since: string | undefined, limit: number): Promise<SyncPullResponse> {
    const cursor = since ? new Date(since) : null;
    const take = Math.min(Math.max(limit, 1), 500);

    const rows = await this.prisma.syncOutbox.findMany({
      where: {
        origin: this.node,
        ...(cursor && !Number.isNaN(cursor.getTime())
          ? { occurredAt: { gt: cursor } }
          : {}),
      },
      orderBy: { occurredAt: 'asc' },
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      changes: page.map((row) => ({
        id: row.id,
        origin: row.origin,
        entity: row.entity,
        entityId: row.entityId,
        operation: row.operation,
        payload: row.payload as Record<string, unknown>,
        occurredAt: row.occurredAt.toISOString(),
      })),
      cursor: page.at(-1)?.occurredAt.toISOString() ?? null,
      hasMore,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Supervision                                                         */
  /* ------------------------------------------------------------------ */

  /** Ce que le back-office affiche : la liaison tient-elle, et que reste-t-il ? */
  async status() {
    const [state, pending, failed, conflicts, lastSent] = await Promise.all([
      this.prisma.syncState.findUnique({ where: { id: 'sync' } }),
      this.prisma.syncOutbox.count({
        where: { origin: this.node, status: SyncStatus.PENDING },
      }),
      this.prisma.syncOutbox.count({
        where: { origin: this.node, status: SyncStatus.FAILED },
      }),
      this.prisma.syncConflict.count({ where: { resolvedAt: null } }),
      this.prisma.syncOutbox.findFirst({
        where: { origin: this.node, status: SyncStatus.SENT },
        orderBy: { syncedAt: 'desc' },
        select: { syncedAt: true },
      }),
    ]);

    const lastPushAt = state?.lastPushAt ?? null;
    // « En ligne » ne se déduit pas d'un ping mais du dernier échange
    // réussi : c'est ce qui compte pour savoir si les ventes sont remontées.
    const online =
      this.enabled &&
      !state?.lastError &&
      lastPushAt !== null &&
      Date.now() - lastPushAt.getTime() < this.intervalSeconds * 3000;

    return {
      enabled: this.enabled,
      node: this.node,
      peer: peerOf(this.node),
      online,
      pendingCount: pending,
      failedCount: failed,
      unresolvedConflicts: conflicts,
      lastPushAt: lastPushAt?.toISOString() ?? null,
      lastPullAt: state?.lastPullAt?.toISOString() ?? null,
      lastSyncedAt: lastSent?.syncedAt?.toISOString() ?? null,
      lastError: state?.lastError ?? null,
      pushedCount: state?.pushedCount ?? 0,
      pulledCount: state?.pulledCount ?? 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Appel au nœud pair.
   *
   * Un délai court et assumé : si le réseau ne répond pas en dix secondes,
   * mieux vaut retenter au cycle suivant que bloquer le service.
   */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${this.peerUrl}/api/v1${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          // Un secret partagé entre serveurs, jamais un jeton d'utilisateur :
          // la synchronisation n'agit au nom de personne.
          'X-Sync-Secret': this.secret,
          'X-Sync-Node': this.node,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Le nœud pair a répondu ${response.status}.`);
      }

      const payload = (await response.json()) as { data: T };
      return payload.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Crée la ligne d'état au premier démarrage. */
  private async ensureState(): Promise<void> {
    await this.prisma.syncState.upsert({
      where: { id: 'sync' },
      update: { node: this.node },
      create: { id: 'sync', node: this.node },
    });
  }
}
