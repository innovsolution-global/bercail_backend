import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';
import { RedisService } from './redis/redis.service';

/**
 * Démarrage de l'API.
 *
 * Un seul serveur sert les quatre rôles : Flutter (client, livreur) et
 * React (admin, super-admin). Rien ici n'est spécifique à un frontend.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    // Conserve les octets reçus en plus du corps analysé. Les rappels des
    // opérateurs de paiement se signent sur ces octets exacts : un
    // `JSON.parse` suivi d'un `JSON.stringify` réordonne les clés et
    // invaliderait une signature pourtant authentique.
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('port') ?? 3000;
  const prefix = config.get<string>('apiPrefix') ?? 'api/v1';
  const isProduction = config.get<boolean>('isProduction') === true;

  // ── Sécurité HTTP ────────────────────────────────────────────────────────
  app.use(
    helmet({
      // Swagger charge ses propres ressources : la CSP par défaut le casserait.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());

  // Derrière un reverse proxy : indispensable pour lire la vraie IP
  // (limitation de débit, journal d'audit).
  app.set('trust proxy', 1);

  const corsOrigins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors({
    origin: (origin, callback) => {
      // Les applications mobiles n'envoient pas d'origine : on les laisse
      // passer, elles sont de toute façon soumises au JWT.
      if (!origin || corsOrigins.includes(origin) || corsOrigins.includes('*')) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origine non autorisée : ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // Tout en-tête que le back-office envoie doit figurer ici : le
    // navigateur refuse la requête *avant* de l'émettre s'il en manque un,
    // et l'application ne voit qu'une panne réseau, sans rien pour la
    // diagnostiquer.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Restaurant-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
    /*
     * Durée de cache du pré-vol.
     *
     * Une journée en production : le navigateur évite un aller-retour avant
     * chaque requête, et la liste d'en-têtes n'y bouge qu'entre deux
     * versions.
     *
     * Dix minutes en développement, et c'est délibéré : un en-tête ajouté
     * côté back-office reste sinon refusé pendant vingt-quatre heures par un
     * cache que le serveur ne peut pas invalider — la panne se présente
     * alors comme une coupure réseau, sur une correction pourtant déjà
     * déployée.
     */
    maxAge: config.get<string>('env') === 'production' ? 86_400 : 600,
  });

  // ── Contrat d'entrée ─────────────────────────────────────────────────────
  // Le préfixe porte déjà la version (`api/v1`) : activer en plus le
  // versionnage d'URI produirait `/api/v1/v1/...`.
  app.setGlobalPrefix(prefix, {
    exclude: [
      // Les sondes doivent rester joignables sans préfixe de version.
      'health',
      'health/live',
      'health/ready',
      // Le rappel de l'opérateur de paiement porte l'adresse que nous lui
      // avons déclarée (`CHAPCHAP_PUBLIC_NOTIFY_PATH`) : la préfixer ici
      // produirait `/api/v1/v1/webhooks/...`, et l'opérateur appellerait
      // dans le vide.
      'v1/webhooks/chapchap',
    ],
  });

  // ── Fichiers téléversés (pilote local) ───────────────────────────────────
  const uploadDir = config.get<string>('storage.localDir') ?? 'uploads';
  app.useStaticAssets(join(process.cwd(), uploadDir), {
    prefix: '/uploads/',
    setHeaders: (res) => {
      // Helmet pose `Cross-Origin-Resource-Policy: same-origin` sur tout.
      // Or ces fichiers sont justement faits pour être affichés depuis le
      // back-office, servi sur une autre origine : sans cette dérogation le
      // navigateur bloque l'image alors que la réponse est un 200, et les
      // avatars retombent silencieusement sur les initiales.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // Les noms de fichiers sont des UUID : un contenu donné ne change
      // jamais d'adresse, on peut donc le mettre en cache sans réserve.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });

  // ── WebSocket ────────────────────────────────────────────────────────────
  const redis = app.get(RedisService);
  const ioAdapter = new RedisIoAdapter(app, redis);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // ── Documentation ────────────────────────────────────────────────────────
  if (config.get<boolean>('swaggerEnabled')) {
    const documentConfig = new DocumentBuilder()
      .setTitle('LE BERCAIL — API')
      .setDescription(
        [
          'API unique de la plateforme Le Bercail.',
          '',
          "Elle sert quatre rôles depuis un seul backend : CUSTOMER et DRIVER (application Flutter), ADMIN et SUPER_ADMIN (back-office React).",
          '',
          '**Conventions**',
          '- Montants : entiers en GNF (jamais de flottant).',
          '- Dates : UTC, format ISO 8601.',
          '- Énumérations : `role` et permissions en MAJUSCULES, toutes les autres en minuscules.',
          '- Réponses : `{ success, data }`, et `{ success, data, meta }` pour les listes paginées.',
          '- Erreurs : `{ success: false, code, message, error }`.',
          '',
          "**Autorisation** — quatre barrières successives : authentification, rôle, permission, appartenance. Le frontend n'est jamais une source de confiance.",
        ].join('\n'),
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
        'bearer',
      )
      .addTag('Auth', 'Inscription, connexion, sessions, mots de passe')
      .addTag('Users', 'Comptes')
      .addTag('Customers', 'Clients et profils')
      .addTag('Drivers', 'Livreurs et espace livreur')
      .addTag('Admins', 'Administrateurs')
      .addTag('SuperAdmin', 'Supervision, permissions')
      .addTag('Restaurant', 'Fiche publique du restaurant')
      .addTag('Menu', 'Plats')
      .addTag('Categories', 'Catégories de la carte')
      .addTag('Orders', 'Panier et commandes')
      .addTag('Payments', 'Paiements et remboursements')
      .addTag('Deliveries', 'Livraisons, géolocalisation, code de remise')
      .addTag('Notifications', 'Notifications applicatives')
      .addTag('Promotions', 'Codes promotionnels')
      .addTag('Reports', 'Tableaux de bord et rapports')
      .addTag('Settings', 'Paramètres et fichiers')
      .addTag('Audit', "Journal d'audit")
      .addTag('Search', 'Recherche globale')
      .addTag('Health', 'Sondes de santé')
      .addServer(config.get<string>('apiUrl') ?? `http://localhost:${port}`)
      .build();

    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'LE BERCAIL — API',
    });
  }

  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');

  logger.log(`LE BERCAIL API démarrée sur http://localhost:${port}/${prefix}`);
  if (config.get<boolean>('swaggerEnabled')) {
    logger.log(`Documentation : http://localhost:${port}/docs`);
  }
  logger.log(`WebSocket : ws://localhost:${port}/realtime`);

  void warnIfCallbackUnreachable(config, logger);
}

/**
 * Prévient si Chap Chap ne pourra pas nous rappeler.
 *
 * Le rappel signé est ce qui fait passer une commande en payée. S'il
 * n'arrive pas — tunnel éteint, adresse publique périmée — le client
 * paie chez son opérateur et la commande reste « en cours »
 * indéfiniment, **sans le moindre message** : rien n'échoue, tout
 * attend. C'est le pire mode de panne qui soit, et il se voit ici en
 * une requête.
 *
 * La vérification ne bloque pas le démarrage : elle avertit, et le
 * serveur tourne. Un développeur qui travaille sur autre chose que le
 * paiement n'a pas à monter un tunnel pour lancer son API.
 */
async function warnIfCallbackUnreachable(
  config: ConfigService,
  logger: Logger,
): Promise<void> {
  if (config.get<boolean>('payment.chapchap.enabled') !== true) return;

  const publicBase = config.get<string>('payment.chapchap.publicBaseUrl');
  if (!publicBase) {
    logger.warn(
      'CHAPCHAP_PUBLIC_BASE_URL est vide : Chap Chap n’a aucune adresse où ' +
        'nous rappeler, les paiements resteront « en cours ».',
    );
    return;
  }

  try {
    const response = await fetch(`${publicBase.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'bypass-tunnel-reminder': '1' },
    });

    if (!response.ok) {
      logger.warn(
        `L’adresse publique ${publicBase} répond ${response.status} : le ` +
          'rappel de paiement n’arrivera pas. Lancez `npm run tunnel`.',
      );
      return;
    }

    logger.log(`Rappels de paiement attendus sur ${publicBase}`);
  } catch {
    logger.warn(
      `L’adresse publique ${publicBase} est injoignable : le rappel de ` +
        'paiement n’arrivera pas, et les commandes réglées en ligne ' +
        'resteront « en cours ». Lancez `npm run tunnel`.',
    );
  }
}

void bootstrap();
