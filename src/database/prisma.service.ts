import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { withRestaurantScope } from './restaurant-scope.extension';

/**
 * Client Prisma partagé.
 *
 * Un seul client pour toute l'application (le pool de connexions ne doit
 * pas être dupliqué), avec :
 *  - la journalisation des requêtes lentes en développement ;
 *  - un helper de transaction qui rejoue les conflits de sérialisation.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      datasources: { db: { url: config.get<string>('database.url') } },
      log:
        config.get<string>('env') === 'development'
          ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
          : ['warn', 'error'],
    });

    /*
     * Le cloisonnement par établissement est monté ici, sur le client
     * partagé, et non dans les services.
     *
     * Une extension Prisma renvoie un nouveau client : on le substitue à
     * l'instance en le renvoyant depuis le constructeur. Les services
     * continuent d'écrire `this.prisma.expense.findMany(...)` sans rien
     * savoir de tout ceci — et c'est exactement le but, puisqu'un filtre
     * qu'on peut oublier n'est pas un cloisonnement.
     */
    return withRestaurantScope(this);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Connexion PostgreSQL établie.');
    } catch (error) {
      // Sans base, l'API ne peut rien servir : on échoue vite, avec un
      // message actionnable plutôt qu'une trace de moteur Prisma.
      const code = (error as { errorCode?: string }).errorCode;
      const hints: Record<string, string> = {
        P1000: "identifiants invalides — vérifiez DATABASE_URL (utilisateur et mot de passe).",
        P1001: "serveur injoignable — vérifiez l'hôte, le port et que PostgreSQL est démarré.",
        P1003: "la base n'existe pas — créez-la, puis exécutez `npx prisma migrate deploy`.",
      };

      this.logger.error(
        `Connexion PostgreSQL impossible${code ? ` (${code})` : ''} : ${hints[code ?? ''] ?? (error as Error).message}`,
      );
      throw new Error('Connexion à la base de données impossible.');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Transaction sérialisable avec reprise.
   *
   * Deux commandes simultanées sur le même stock, ou deux tentatives
   * d'assignation du même livreur, provoquent une erreur P2034 : PostgreSQL
   * a raison de refuser, il suffit de rejouer.
   */
  async transaction<T>(
    handler: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { retries?: number; timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel } = {},
  ): Promise<T> {
    const retries = options.retries ?? 3;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await this.$transaction(handler, {
          timeout: options.timeoutMs ?? 15_000,
          isolationLevel: options.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
        });
      } catch (error) {
        const isRetryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2028');

        if (!isRetryable || attempt === retries) throw error;

        this.logger.warn(`Conflit transactionnel (${error.code}), tentative ${attempt}/${retries}.`);
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }

    // Inatteignable : la boucle renvoie ou relance toujours.
    throw new Error('Transaction impossible.');
  }

  /** Filtre standard des entités non supprimées (soft delete). */
  get notDeleted() {
    return { deletedAt: null };
  }

  /** Vide les tables métier — réservé aux tests et au seed. */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('truncateAll est interdit en production.');
    }

    const tables = await this.$queryRaw<{ tablename: string }[]>(
      Prisma.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
    );

    if (tables.length === 0) return;

    const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
    await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
  }
}
