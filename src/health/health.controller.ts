import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Public } from '../common/decorators';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Sonde de santé.
 *
 * Route publique, sans authentification : elle est appelée par
 * l'orchestrateur (Docker, Kubernetes) et par la supervision. Elle ne
 * révèle aucune donnée métier, seulement l'état des dépendances.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Public()
  @ApiEndpoint({
    summary: 'État du service',
    description: 'API, base de données et cache. Renvoie 200 même en mode dégradé (cache absent).',
    public: true,
  })
  async check() {
    const databaseStartedAt = Date.now();
    let database: 'up' | 'down' = 'up';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    const databaseLatencyMs = Date.now() - databaseStartedAt;
    const cache = (await this.redis.ping()) ? 'up' : 'degraded';

    return {
      status: database === 'up' ? 'ok' : 'error',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        api: 'up',
        database,
        databaseLatencyMs,
        cache,
      },
    };
  }

  @Get('live')
  @Public()
  @ApiEndpoint({
    summary: 'Sonde de vivacité',
    description: 'Répond dès que le processus est démarré, sans toucher aux dépendances.',
    public: true,
  })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  @ApiEndpoint({
    summary: 'Sonde de disponibilité',
    description: "Vérifie que la base répond : c'est la condition pour recevoir du trafic.",
    public: true,
  })
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ready' };
  }
}
