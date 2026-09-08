import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import type { RedisService } from '../redis/redis.service';

/**
 * Adaptateur WebSocket multi-instances.
 *
 * Sans lui, deux instances de l'API ne partagent pas leurs salons : une
 * commande créée sur l'instance A ne parviendrait pas au tableau de bord
 * connecté à l'instance B. Le bus Redis règle ce problème.
 *
 * Si Redis est absent, l'adaptateur reste en mode local : le temps réel
 * fonctionne pour une instance unique, ce qui suffit en développement.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly redis: RedisService,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    let publisher: ReturnType<RedisService['createClient']> | undefined;
    let subscriber: ReturnType<RedisService['createClient']> | undefined;

    try {
      publisher = this.redis.createClient();
      subscriber = publisher.duplicate();

      await Promise.all([publisher.connect(), subscriber.connect()]);

      this.adapterConstructor = createAdapter(publisher, subscriber);
      this.logger.log('Adaptateur WebSocket Redis actif (montée en charge possible).');
    } catch (error) {
      // On referme les connexions ratées : sans cela, ioredis continuerait
      // de réessayer en boucle pour rien.
      await Promise.all([
        publisher?.quit().catch(() => undefined),
        subscriber?.quit().catch(() => undefined),
      ]);

      this.logger.warn(
        `Adaptateur Redis indisponible (${(error as Error).message}) : temps réel en mode instance unique.`,
      );
    }
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: true, credentials: true },
      // Réseau mobile : on tolère une latence élevée avant de couper.
      pingTimeout: 30_000,
      pingInterval: 25_000,
      transports: ['websocket', 'polling'],
    });

    if (this.adapterConstructor) {
      (server as { adapter: (factory: unknown) => void }).adapter(this.adapterConstructor);
    }

    return server;
  }
}
