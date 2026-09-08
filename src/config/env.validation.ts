/**
 * Validation de l'environnement au démarrage.
 *
 * L'application refuse de démarrer en production si un secret manque ou
 * s'il est resté sur sa valeur de développement : mieux vaut un crash au
 * boot qu'une API signée avec « dev-access-secret-change-me ».
 */

const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'REDIS_URL',
  'CORS_ORIGINS',
] as const;

const FORBIDDEN_PRODUCTION_VALUES = [
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  'change-me',
  'SuperAdmin@2024',
];

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const env = (config.NODE_ENV as string) ?? 'development';
  const errors: string[] = [];

  if (env === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      const value = config[key];
      if (!value || String(value).trim() === '') {
        errors.push(`${key} est obligatoire en production.`);
      }
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'SUPER_ADMIN_PASSWORD']) {
      const value = String(config[key] ?? '');
      if (value && FORBIDDEN_PRODUCTION_VALUES.includes(value)) {
        errors.push(`${key} utilise une valeur de développement : changez-la.`);
      }
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      const value = String(config[key] ?? '');
      if (value && value.length < 32) {
        errors.push(`${key} doit faire au moins 32 caractères.`);
      }
    }

    if (config.JWT_ACCESS_SECRET && config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
      errors.push('JWT_ACCESS_SECRET et JWT_REFRESH_SECRET doivent être différents.');
    }
  }

  const port = Number.parseInt(String(config.PORT ?? '3000'), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    errors.push('PORT doit être un entier valide entre 1 et 65535.');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration invalide :\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
