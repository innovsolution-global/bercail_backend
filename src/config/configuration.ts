/**
 * Configuration applicative.
 *
 * Une seule source de vérité pour tout ce qui vient de l'environnement.
 * Aucun module ne lit `process.env` directement : ils passent tous par
 * `ConfigService`, ce qui rend la configuration testable et documentée.
 */

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function toList(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface AppConfiguration {
  env: string;
  isProduction: boolean;
  port: number;
  apiPrefix: string;
  apiUrl: string;
  corsOrigins: string[];
  swaggerEnabled: boolean;
  database: { url: string };
  redis: { url: string; enabled: boolean; keyPrefix: string };
  jwt: {
    accessSecret: string;
    accessExpiresIn: string;
    accessTtlSeconds: number;
    refreshSecret: string;
    refreshExpiresIn: string;
    refreshTtlSeconds: number;
    issuer: string;
    audience: string;
  };
  security: {
    bcryptRounds: number;
    maxLoginAttempts: number;
    lockoutMinutes: number;
    passwordMinLength: number;
    activationTokenTtlHours: number;
    resetTokenTtlMinutes: number;
  };
  throttle: { ttlSeconds: number; limit: number };
  otp: { length: number; ttlMinutes: number; maxAttempts: number };
  cache: { menuTtlSeconds: number; settingsTtlSeconds: number };
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    publicUrl: string;
    maxFileSizeBytes: number;
    s3: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };
  };
  push: {
    driver: 'noop' | 'fcm';
    /** Le fichier JSON du compte de service Firebase, tel que téléchargé. */
    serviceAccountFile: string;
    fcmProjectId: string;
    fcmClientEmail: string;
    fcmPrivateKey: string;
  };
  mail: {
    driver: 'noop' | 'smtp';
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
    /** Racine du back-office, pour construire les liens des e-mails. */
    backOfficeUrl: string;
  };
  payment: {
    orangeMoney: { enabled: boolean; baseUrl: string; merchantId: string; apiKey: string };
    mtnMoney: { enabled: boolean; baseUrl: string; merchantId: string; apiKey: string };
    card: { enabled: boolean; publicKey: string; secretKey: string };
    /**
     * Chap Chap Pay — encaissement mobile money en Guinée.
     *
     * Un seul opérateur remplace les intégrations séparées Orange et MTN :
     * c'est lui qui présente au client le choix de son moyen de paiement.
     * Voir https://chapchappay.com/guide/
     */
    chapchap: {
      /** Déduit de la présence des clés : pas de drapeau à oublier. */
      enabled: boolean;
      baseUrl: string;
      apiKey: string;
      /** Sert à signer les requêtes sortantes. */
      hmacSecret: string;
      /** Chemin de création d'une opération, relatif à `baseUrl`. */
      ecommercePath: string;
      /**
       * Secret de vérification des rappels. Distinct du précédent chez
       * certains opérateurs ; à défaut, `hmacSecret` fait office.
       */
      webhookSecret: string;
      signatureHeader: string;
      /**
       * Adresse publique du serveur, telle que Chap Chap peut la joindre.
       *
       * Distincte d'`API_URL` : en développement celle-ci vaut
       * `localhost`, que les serveurs de l'opérateur ne peuvent pas
       * atteindre. C'est ici qu'on met l'adresse du tunnel.
       */
      publicBaseUrl: string;
      /** Chemin public que Chap Chap rappellera. */
      notifyPath: string;
      /** Site qui accueille le client après paiement. */
      frontendBaseUrl: string;
      /** Page d'atterrissage après un paiement abouti. */
      returnPath: string;
      /** Page d'atterrissage après un abandon ou un refus. */
      cancelPath: string;
      /**
       * Accepte un rappel non signé.
       *
       * Uniquement pour un poste de développement sans tunnel : sans
       * signature, n'importe qui peut déclarer un paiement encaissé.
       */
      allowUnsigned: boolean;
      /** Nommage des champs envoyés : `snake` ou `camel`. */
      bodyStyle: 'snake' | 'camel';
    };
    /** En développement, les paiements mobiles sont simulés localement. */
    sandbox: boolean;
  };
  orders: {
    /** Délai pendant lequel un client peut encore annuler seul, en minutes. */
    customerCancelWindowMinutes: number;
    referencePrefix: string;
  };
  /**
   * Synchronisation entre le serveur du restaurant et celui en ligne.
   *
   * Le nœud LOCAL est celui posé sur place : c'est toujours lui qui engage
   * l'échange, parce qu'il est derrière la box du restaurant et que le
   * serveur en ligne ne peut pas le joindre.
   */
  sync: {
    enabled: boolean;
    node: 'LOCAL' | 'CLOUD';
    /** URL du nœud pair. Renseignée seulement côté LOCAL. */
    peerUrl: string;
    /** Secret partagé entre les deux nœuds, distinct des jetons utilisateurs. */
    secret: string;
    /** Intervalle entre deux tentatives d'échange, en secondes. */
    intervalSeconds: number;
    /** Nombre d'écritures transmises par lot. */
    batchSize: number;
  };
  bootstrap: {
    superAdminEmail: string;
    superAdminPassword: string;
    superAdminPhone: string;
  };
  observability: { sentryDsn: string; metricsEnabled: boolean; logLevel: string };
}

export default (): AppConfiguration => {
  const env = process.env.NODE_ENV ?? 'development';
  const port = toInt(process.env.PORT, 3000);

  return {
    env,
    isProduction: env === 'production',
    port,
    apiPrefix: process.env.API_PREFIX ?? 'api/v1',
    apiUrl: process.env.API_URL ?? `http://localhost:${port}`,
    corsOrigins: toList(process.env.CORS_ORIGINS, [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8080',
    ]),
    swaggerEnabled: toBool(process.env.SWAGGER_ENABLED, env !== 'production'),

    database: {
      url:
        process.env.DATABASE_URL ??
        'postgresql://bercail:bercail@localhost:5432/bercail?schema=public',
    },

    redis: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      enabled: toBool(process.env.REDIS_ENABLED, true),
      keyPrefix: process.env.REDIS_PREFIX ?? 'bercail:',
    },

    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
      accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
      accessTtlSeconds: toInt(process.env.JWT_ACCESS_TTL_SECONDS, 900),
      refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
      refreshTtlSeconds: toInt(process.env.JWT_REFRESH_TTL_SECONDS, 60 * 60 * 24 * 30),
      issuer: process.env.JWT_ISSUER ?? 'le-bercail',
      audience: process.env.JWT_AUDIENCE ?? 'le-bercail-clients',
    },

    security: {
      bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
      maxLoginAttempts: toInt(process.env.MAX_LOGIN_ATTEMPTS, 5),
      lockoutMinutes: toInt(process.env.LOGIN_LOCKOUT_MINUTES, 15),
      passwordMinLength: toInt(process.env.PASSWORD_MIN_LENGTH, 8),
      activationTokenTtlHours: toInt(process.env.ACTIVATION_TOKEN_TTL_HOURS, 72),
      resetTokenTtlMinutes: toInt(process.env.RESET_TOKEN_TTL_MINUTES, 30),
    },

    throttle: {
      ttlSeconds: toInt(process.env.THROTTLE_TTL_SECONDS, 60),
      limit: toInt(process.env.THROTTLE_LIMIT, 120),
    },

    otp: {
      length: toInt(process.env.OTP_LENGTH, 4),
      ttlMinutes: toInt(process.env.OTP_TTL_MINUTES, 60),
      maxAttempts: toInt(process.env.OTP_MAX_ATTEMPTS, 5),
    },

    cache: {
      menuTtlSeconds: toInt(process.env.CACHE_MENU_TTL_SECONDS, 300),
      settingsTtlSeconds: toInt(process.env.CACHE_SETTINGS_TTL_SECONDS, 600),
    },

    storage: {
      driver: (process.env.STORAGE_DRIVER as 'local' | 's3') ?? 'local',
      localDir: process.env.STORAGE_LOCAL_DIR ?? 'uploads',
      publicUrl: process.env.STORAGE_PUBLIC_URL ?? `http://localhost:${port}/uploads`,
      maxFileSizeBytes: toInt(process.env.STORAGE_MAX_FILE_SIZE, 5 * 1024 * 1024),
      s3: {
        endpoint: process.env.S3_ENDPOINT ?? '',
        region: process.env.S3_REGION ?? 'us-east-1',
        bucket: process.env.S3_BUCKET ?? '',
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: toBool(process.env.S3_FORCE_PATH_STYLE, true),
      },
    },

    push: {
      driver: (process.env.PUSH_DRIVER as 'noop' | 'fcm') ?? 'noop',
      serviceAccountFile: process.env.FIREBASE_SERVICE_ACCOUNT_FILE ?? '',
      fcmProjectId: process.env.FCM_PROJECT_ID ?? '',
      fcmClientEmail: process.env.FCM_CLIENT_EMAIL ?? '',
      fcmPrivateKey: (process.env.FCM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    },

    mail: {
      driver: (process.env.MAIL_DRIVER as 'noop' | 'smtp') ?? 'noop',
      host: process.env.MAIL_HOST ?? 'smtp.gmail.com',
      port: toInt(process.env.MAIL_PORT, 587),
      // 465 impose TLS d'emblee ; 587 passe par STARTTLS.
      secure: toBool(process.env.MAIL_SECURE, toInt(process.env.MAIL_PORT, 587) === 465),
      user: process.env.MAIL_USER ?? '',
      password: process.env.MAIL_PASSWORD ?? '',
      from: process.env.MAIL_FROM ?? 'Les Saveurs du Bercail <no-reply@lebercail.gn>',
      backOfficeUrl: process.env.BACK_OFFICE_URL ?? 'http://localhost:5173',
    },

    payment: {
      orangeMoney: {
        enabled: toBool(process.env.ORANGE_MONEY_ENABLED, true),
        baseUrl: process.env.ORANGE_MONEY_BASE_URL ?? '',
        merchantId: process.env.ORANGE_MONEY_MERCHANT_ID ?? '',
        apiKey: process.env.ORANGE_MONEY_API_KEY ?? '',
      },
      mtnMoney: {
        enabled: toBool(process.env.MTN_MONEY_ENABLED, true),
        baseUrl: process.env.MTN_MONEY_BASE_URL ?? '',
        merchantId: process.env.MTN_MONEY_MERCHANT_ID ?? '',
        apiKey: process.env.MTN_MONEY_API_KEY ?? '',
      },
      card: {
        enabled: toBool(process.env.CARD_PAYMENT_ENABLED, false),
        publicKey: process.env.CARD_PUBLIC_KEY ?? '',
        secretKey: process.env.CARD_SECRET_KEY ?? '',
      },
      chapchap: {
        enabled: Boolean(process.env.CHAPCHAP_API_KEY && process.env.CHAPCHAP_HMAC_SECRET),
        baseUrl: (process.env.CHAPCHAP_API_BASE_URL ?? 'https://chapchappay.com/api').replace(
          /\/$/,
          '',
        ),
        apiKey: process.env.CHAPCHAP_API_KEY ?? '',
        hmacSecret: process.env.CHAPCHAP_HMAC_SECRET ?? '',
        ecommercePath: (process.env.CHAPCHAP_ECOMMERCE_PATH ?? 'ecommerce/create').replace(
          /^\//,
          '',
        ),
        // À défaut de secret dédié, les rappels se vérifient avec le même
        // secret que les requêtes sortantes.
        webhookSecret: process.env.CHAPCHAP_WEBHOOK_SECRET || (process.env.CHAPCHAP_HMAC_SECRET ?? ''),
        signatureHeader: (
          process.env.CHAPCHAP_WEBHOOK_SIGNATURE_HEADER ?? 'CCP-HMAC-Signature'
        ).toLowerCase(),
        // Sans tunnel déclaré, on retombe sur l'adresse de l'API : le
        // rappel n'arrivera pas, mais l'écran de supervision le dit.
        publicBaseUrl: (
          process.env.CHAPCHAP_PUBLIC_BASE_URL ||
          process.env.API_URL ||
          `http://localhost:${port}`
        ).replace(/\/$/, ''),
        notifyPath: process.env.CHAPCHAP_PUBLIC_NOTIFY_PATH ?? '/v1/webhooks/chapchap',
        frontendBaseUrl: (process.env.CHAPCHAP_FRONTEND_BASE_URL ?? '').replace(/\/$/, ''),
        returnPath: process.env.CHAPCHAP_RETURN_PATH ?? '/paiement/succes',
        cancelPath: process.env.CHAPCHAP_CANCEL_PATH ?? '/paiement/echec',
        allowUnsigned: toBool(process.env.CHAPCHAP_WEBHOOK_ALLOW_UNSIGNED, false),
        bodyStyle: process.env.CHAPCHAP_REQUEST_BODY_STYLE === 'camel' ? 'camel' : 'snake',
      },

      sandbox: toBool(process.env.PAYMENT_SANDBOX, env !== 'production'),
    },

    orders: {
      customerCancelWindowMinutes: toInt(process.env.ORDER_CANCEL_WINDOW_MINUTES, 10),
      referencePrefix: process.env.ORDER_REFERENCE_PREFIX ?? 'BRC',
    },

    sync: {
      enabled: toBool(process.env.SYNC_ENABLED, false),
      node: (process.env.SYNC_NODE ?? 'LOCAL') as 'LOCAL' | 'CLOUD',
      peerUrl: (process.env.SYNC_PEER_URL ?? '').replace(/\/$/, ''),
      secret: process.env.SYNC_SECRET ?? '',
      intervalSeconds: toInt(process.env.SYNC_INTERVAL_SECONDS, 20),
      batchSize: toInt(process.env.SYNC_BATCH_SIZE, 200),
    },

    bootstrap: {
      superAdminEmail: process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@lebercail.gn',
      superAdminPassword: process.env.SUPER_ADMIN_PASSWORD ?? 'SuperAdmin@2024',
      superAdminPhone: process.env.SUPER_ADMIN_PHONE ?? '+224620000001',
    },

    observability: {
      sentryDsn: process.env.SENTRY_DSN ?? '',
      metricsEnabled: toBool(process.env.METRICS_ENABLED, false),
      logLevel: process.env.LOG_LEVEL ?? (env === 'production' ? 'log' : 'debug'),
    },
  };
};
