import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from './redis.service';

/**
 * Limitation de débit adossée à Redis.
 *
 * Le stockage par défaut de `@nestjs/throttler` vit dans la mémoire du
 * processus : avec deux instances derrière un répartiteur, un attaquant
 * obtient deux fois le quota, et un redémarrage remet tous les compteurs
 * à zéro. Redis règle les deux problèmes.
 *
 * Si Redis est indisponible, on retombe sur un compteur mémoire local :
 * la protection est alors moins stricte, mais l'API continue de servir —
 * c'est le compromis assumé du mode dégradé.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  /** Repli mémoire, utilisé uniquement quand Redis ne répond pas. */
  private readonly fallback = new Map<string, { hits: number; expiresAt: number; blockedUntil: number }>();

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const namespaced = `throttle:${throttlerName}:${key}`;

    if (!this.redis.isAvailable) {
      return this.incrementInMemory(namespaced, ttl, limit, blockDuration);
    }

    // Les durées arrivent en millisecondes ; Redis raisonne en secondes.
    const ttlSeconds = Math.max(1, Math.ceil(ttl / 1000));
    const blockSeconds = Math.max(1, Math.ceil(blockDuration / 1000));

    const blockKey = `${namespaced}:blocked`;
    const blockedTtl = await this.redis.ttl(blockKey);

    if (blockedTtl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: blockedTtl,
        isBlocked: true,
        timeToBlockExpire: blockedTtl,
      };
    }

    const totalHits = await this.redis.increment(namespaced, ttlSeconds);
    const timeToExpire = await this.redis.ttl(namespaced);

    if (totalHits > limit) {
      await this.redis.set(blockKey, 1, blockSeconds);
      return {
        totalHits,
        timeToExpire: Math.max(timeToExpire, 0),
        isBlocked: true,
        timeToBlockExpire: blockSeconds,
      };
    }

    return {
      totalHits,
      timeToExpire: Math.max(timeToExpire, 0),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  private incrementInMemory(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): ThrottlerStorageRecord {
    const now = Date.now();
    const entry = this.fallback.get(key);

    if (entry && entry.blockedUntil > now) {
      return {
        totalHits: limit + 1,
        timeToExpire: Math.ceil((entry.blockedUntil - now) / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.ceil((entry.blockedUntil - now) / 1000),
      };
    }

    if (!entry || entry.expiresAt <= now) {
      this.fallback.set(key, { hits: 1, expiresAt: now + ttl, blockedUntil: 0 });
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    entry.hits += 1;

    if (entry.hits > limit) {
      entry.blockedUntil = now + blockDuration;
      return {
        totalHits: entry.hits,
        timeToExpire: Math.ceil((entry.expiresAt - now) / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    return {
      totalHits: entry.hits,
      timeToExpire: Math.ceil((entry.expiresAt - now) / 1000),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
