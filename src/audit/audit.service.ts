import { Injectable, Logger } from '@nestjs/common';
import { AuditResult, Prisma, Role } from '@prisma/client';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';

export interface AuditEntryInput {
  actor?: Pick<AuthenticatedUser, 'id' | 'firstName' | 'lastName' | 'role'> | null;
  /** Si l'auteur n'est pas un utilisateur (tâche planifiée, webhook). */
  actorName?: string;
  action: string;
  module: string;
  entityType?: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  context?: RequestContext;
  result?: AuditResult;
}

export interface AuditQuery {
  page: number;
  limit: number;
  search?: string;
  actorId?: string;
  role?: Role;
  action?: string;
  module?: string;
  result?: AuditResult;
  from?: string;
  to?: string;
}

/**
 * Journal des actions sensibles.
 *
 * Ce journal est en écriture seule : aucune route ne le modifie ni ne le
 * supprime. Il conserve le nom et le rôle de l'auteur au moment des faits,
 * afin de rester lisible même si le compte disparaît ensuite.
 *
 * L'écriture ne doit jamais faire échouer l'action métier : une panne du
 * journal se voit dans les logs, elle n'annule pas une livraison.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actor?.id ?? null,
          actorName: entry.actor
            ? `${entry.actor.firstName} ${entry.actor.lastName}`.trim()
            : (entry.actorName ?? 'Système'),
          actorRole: entry.actor?.role ?? null,
          action: entry.action,
          module: entry.module,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          oldValue: this.toJson(entry.oldValue),
          newValue: this.toJson(entry.newValue),
          metadata: this.toJson(entry.metadata),
          ipAddress: entry.context?.ipAddress ?? null,
          userAgent: entry.context?.userAgent?.slice(0, 500) ?? null,
          result: entry.result ?? AuditResult.SUCCESS,
        },
      });
    } catch (error) {
      this.logger.error(
        `Écriture du journal d'audit impossible (${entry.action}) : ${(error as Error).message}`,
      );
    }
  }

  /**
   * Différentiel avant/après, limité aux champs réellement modifiés.
   * Les champs sensibles ne sont jamais journalisés en clair.
   */
  diff<T extends Record<string, unknown>>(
    before: T,
    after: Partial<T>,
  ): Record<string, { before: unknown; after: unknown }> {
    const redacted = ['passwordHash', 'password', 'token', 'tokenHash', 'codeHash', 'secret'];
    const changes: Record<string, { before: unknown; after: unknown }> = {};

    for (const [key, value] of Object.entries(after)) {
      if (redacted.some((needle) => key.toLowerCase().includes(needle.toLowerCase()))) {
        changes[key] = { before: '[masqué]', after: '[masqué]' };
        continue;
      }
      const previous = before[key];
      if (JSON.stringify(previous) !== JSON.stringify(value)) {
        changes[key] = { before: previous ?? null, after: value ?? null };
      }
    }

    return changes;
  }

  async list(query: AuditQuery): Promise<PaginatedResult<Record<string, unknown>>> {
    const where: Prisma.AuditLogWhereInput = {};

    if (query.actorId) where.actorId = query.actorId;
    if (query.role) where.actorRole = query.role;
    if (query.action) where.action = query.action;
    if (query.module) where.module = query.module;
    if (query.result) where.result = query.result;

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.OR = [
        { actorName: { contains: query.search, mode: 'insensitive' } },
        { action: { contains: query.search, mode: 'insensitive' } },
        { entityId: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginate(
      rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        actorId: row.actorId ?? '',
        actorName: row.actorName,
        actorRole: row.actorRole ?? null,
        action: row.action,
        module: row.module,
        entityType: row.entityType,
        entityId: row.entityId,
        ipAddress: row.ipAddress ?? '',
        userAgent: row.userAgent,
        result: row.result === AuditResult.SUCCESS ? 'success' : 'failure',
        changes: this.buildChanges(row.oldValue, row.newValue),
      })),
      total,
      query.page,
      query.limit,
    );
  }

  /** Valeurs distinctes, pour alimenter les filtres du back-office. */
  async distinctActions(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
      take: 200,
    });
    return rows.map((row) => row.action);
  }

  async distinctModules(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['module'],
      select: { module: true },
      orderBy: { module: 'asc' },
      take: 100,
    });
    return rows.map((row) => row.module);
  }

  async recent(limit = 10) {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      actorId: row.actorId ?? '',
      actorName: row.actorName,
      actorRole: row.actorRole,
      action: row.action,
      module: row.module,
      entityType: row.entityType,
      entityId: row.entityId,
      ipAddress: row.ipAddress ?? '',
      userAgent: row.userAgent,
      result: row.result === AuditResult.SUCCESS ? 'success' : 'failure',
      changes: this.buildChanges(row.oldValue, row.newValue),
    }));
  }

  /** Purge au-delà de la rétention configurée (tâche planifiée). */
  async purgeOlderThan(days: number): Promise<number> {
    const threshold = new Date(Date.now() - days * 24 * 3600 * 1000);
    const result = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: threshold } } });
    return result.count;
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private buildChanges(
    oldValue: Prisma.JsonValue,
    newValue: Prisma.JsonValue,
  ): Record<string, { before: unknown; after: unknown }> | null {
    if (!oldValue && !newValue) return null;

    // Le service peut journaliser soit un différentiel déjà construit,
    // soit deux instantanés : les deux formes sont acceptées ici.
    if (
      oldValue &&
      typeof oldValue === 'object' &&
      !Array.isArray(oldValue) &&
      newValue &&
      typeof newValue === 'object' &&
      !Array.isArray(newValue)
    ) {
      const before = oldValue as Record<string, unknown>;
      const after = newValue as Record<string, unknown>;
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
          changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
        }
      }
      return Object.keys(changes).length > 0 ? changes : null;
    }

    return null;
  }
}
