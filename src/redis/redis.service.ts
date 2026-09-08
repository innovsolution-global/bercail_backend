import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Accès Redis, en mode dégradé si le serveur est absent.
 *
 * Redis sert de cache (carte, réglages), de compteur (limitation de
 * débit, tentatives OTP) et de bus pour la montée en charge des
 * WebSockets. Aucun de ces usages n'est vital : si Redis tombe,
 * l'API continue de répondre, simplement sans cache. C'est un choix
 * explicite — un restaurant ne doit pas cesser de vendre parce qu'un
 * cache est indisponible.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private available = false;
  private readonly prefix: string;
  private readonly enabled: boolean;
  private readonly url: string;

  constructor(private readonly config: ConfigService) {
    this.prefix = this.config.get<string>('redis.keyPrefix') ?? 'bercail:';
    this.enabled = this.config.get<boolean>('redis.enabled') ?? true;
    this.url = this.config.get<string>('redis.url') ?? 'redis://localhost:6379';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Redis désactivé par configuration : cache et compteurs en mémoire.');
      return;
    }

    this.client = this.createClient();

    this.client.on('ready', () => {
      this.available = true;
      this.logger.log('Connexion Redis établie.');
    });

    this.client.on('error', (error: Error) => {
      if (this.available) {
        this.logger.warn(`Redis indisponible : ${error.message}. Mode dégradé.`);
      }
      this.available = false;
    });

    try {
      await this.client.connect();
    } catch (error) {
      this.available = false;
      this.logger.warn(
        `Redis injoignable (${(error as Error).message}). L'API démarre en mode dégradé.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;

    await this.client.quit().catch(() => undefined);

    // `quit()` ne suffit pas si le client n'a jamais réussi à se connecter :
    // sa boucle de reconnexion garde un timer actif, et le processus ne se
    // termine jamais (arrêt de conteneur bloqué, suite de tests suspendue).
    // `disconnect()` annule ce timer.
    this.client.disconnect();
    this.client = null;
    this.available = false;
  }

  /** Nouvelle connexion — l'adaptateur WebSocket a besoin de la sienne. */
  createClient(): Redis {
    const client = new Redis(this.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 500, 5_000),
    });

    // Sans écouteur, ioredis écrit « Unhandled error event » sur la sortie
    // d'erreur à chaque tentative. On journalise une fois, proprement.
    client.on('error', (error: Error) => {
      this.logger.debug(`Client Redis : ${error.message}`);
    });

    return client;
  }

  get isAvailable(): boolean {
    return this.available && this.client !== null;
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable) return null;
    try {
      const raw = await this.client!.get(this.key(key));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.isAvailable) return;
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client!.set(this.key(key), payload, 'EX', ttlSeconds);
      } else {
        await this.client!.set(this.key(key), payload);
      }
    } catch {
      // Un cache qui échoue ne doit jamais faire échouer la requête.
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.isAvailable || keys.length === 0) return;
    try {
      await this.client!.del(...keys.map((key) => this.key(key)));
    } catch {
      /* mode dégradé */
    }
  }

  /** Invalide toutes les clés d'un préfixe (ex. `menu:` après édition). */
  async delByPattern(pattern: string): Promise<void> {
    if (!this.isAvailable) return;
    try {
      const stream = this.client!.scanStream({ match: this.key(pattern), count: 200 });
      const batch: string[] = [];
      for await (const keys of stream as AsyncIterable<string[]>) {
        batch.push(...keys);
      }
      if (batch.length > 0) await this.client!.del(...batch);
    } catch {
      /* mode dégradé */
    }
  }

  /**
   * Cache « lecture avec repli » : renvoie la valeur en cache si elle
   * existe, sinon exécute la requête et mémorise le résultat.
   */
  async remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await loader();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /** Compteur atomique avec expiration — base de la limitation de débit. */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (!this.isAvailable) return 0;
    try {
      const namespaced = this.key(key);
      const value = await this.client!.incr(namespaced);
      if (value === 1) await this.client!.expire(namespaced, ttlSeconds);
      return value;
    } catch {
      return 0;
    }
  }

  async ttl(key: string): Promise<number> {
    if (!this.isAvailable) return -1;
    try {
      return await this.client!.ttl(this.key(key));
    } catch {
      return -1;
    }
  }

  /** Verrou distribué court, pour les opérations non rejouables. */
  async acquireLock(key: string, ttlSeconds = 10): Promise<boolean> {
    if (!this.isAvailable) return true;
    try {
      const result = await this.client!.set(this.key(`lock:${key}`), '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch {
      return true;
    }
  }

  async releaseLock(key: string): Promise<void> {
    await this.del(`lock:${key}`);
  }

  async ping(): Promise<boolean> {
    if (!this.isAvailable) return false;
    try {
      return (await this.client!.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
