import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import { hashPayload } from '../utils/crypto.util';

/**
 * Idempotence des opérations sensibles.
 *
 * Sur un réseau mobile, une requête de création de commande peut partir
 * deux fois : l'application n'a pas reçu la réponse et rejoue. Sans
 * protection, le client est débité deux fois et la cuisine prépare deux
 * repas.
 *
 * Le contrat est celui des API de paiement :
 *  - même clé + même corps → la première réponse est rejouée ;
 *  - même clé + corps différent → 409, la clé a déjà servi à autre chose ;
 *  - clé en cours de traitement → 409, une seule exécution à la fois.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(
    options: {
      userId: string;
      endpoint: string;
      key?: string;
      payload: unknown;
      ttlHours?: number;
    },
    handler: () => Promise<T>,
  ): Promise<T> {
    const { userId, endpoint, key, payload } = options;

    // Sans clé, on exécute normalement : l'idempotence est proposée, pas imposée.
    if (!key) return handler();

    const requestHash = hashPayload(payload);
    const expiresAt = new Date(Date.now() + (options.ttlHours ?? 24) * 3600 * 1000);

    try {
      await this.prisma.idempotencyKey.create({
        data: { userId, key, endpoint, requestHash, expiresAt },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.replay<T>(userId, endpoint, key, requestHash);
      }
      throw error;
    }

    try {
      const result = await handler();

      await this.prisma.idempotencyKey.updateMany({
        where: { userId, key, endpoint },
        data: {
          statusCode: 201,
          response: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      return result;
    } catch (error) {
      // L'opération a échoué : la clé doit redevenir utilisable, sinon un
      // client bloqué par une erreur temporaire ne pourrait plus commander.
      await this.prisma.idempotencyKey
        .deleteMany({ where: { userId, key, endpoint, completedAt: null } })
        .catch(() => undefined);
      throw error;
    }
  }

  private async replay<T>(
    userId: string,
    endpoint: string,
    key: string,
    requestHash: string,
  ): Promise<T> {
    const existing = await this.prisma.idempotencyKey.findFirst({
      where: { userId, key, endpoint },
    });

    if (!existing) {
      throw AppException.conflict(
        ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
        'Une opération identique est en cours. Réessayez dans un instant.',
      );
    }

    if (existing.requestHash !== requestHash) {
      throw AppException.conflict(
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        'Cette clé d’idempotence a déjà été utilisée avec un contenu différent.',
      );
    }

    if (!existing.completedAt) {
      throw AppException.conflict(
        ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
        'Une opération identique est en cours. Réessayez dans un instant.',
      );
    }

    this.logger.debug(`Réponse rejouée pour la clé d'idempotence ${key} (${endpoint}).`);
    return existing.response as T;
  }

  /** Purge des clés expirées (tâche planifiée). */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }
}
