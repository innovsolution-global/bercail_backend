import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Role, SyncNode } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiEndpoint, Public, RequirePermissions, Roles } from '../common/decorators';
import { SyncApplyService } from './sync-apply.service';
import { SyncGuard } from './sync.guard';
import { SyncService } from './sync.service';
import type { SyncChange } from './sync.contract';

class PullQueryDto {
  @ApiPropertyOptional({ description: 'Horodatage de la dernière écriture déjà reçue.' })
  @IsOptional()
  @IsString()
  since?: string;

  @ApiPropertyOptional({ default: 200, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class PushBodyDto {
  @ApiPropertyOptional({ enum: SyncNode })
  @IsString()
  node!: SyncNode;

  @ApiPropertyOptional({ type: [Object] })
  @IsArray()
  changes!: SyncChange[];
}

/**
 * Échange entre les deux serveurs.
 *
 * Ces routes ne servent pas les applications : elles ne parlent qu'au nœud
 * pair, et s'authentifient par un secret partagé plutôt que par un jeton
 * d'utilisateur. `@Public()` écarte la chaîne de garde habituelle, que
 * `SyncGuard` remplace entièrement.
 */
@ApiTags('Synchronisation')
@Controller('sync')
export class SyncNodeController {
  constructor(
    private readonly sync: SyncService,
    private readonly applier: SyncApplyService,
  ) {}

  @Post('push')
  @Public()
  @UseGuards(SyncGuard)
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Recevoir les écritures du nœud pair',
    description:
      "Applique un lot d'écritures. Rejouer le même lot est sans effet : chaque écriture porte l'identifiant que l'émetteur lui a donné.",
    public: true,
  })
  push(@Body() body: PushBodyDto) {
    // On applique avec l'identité de CE serveur : le champ `node` du corps
    // est déclaratif, il ne décide de rien.
    return this.applier.apply(body.changes ?? [], this.sync.currentNode);
  }

  @Get('pull')
  @Public()
  @UseGuards(SyncGuard)
  @ApiEndpoint({
    summary: 'Transmettre les écritures de ce nœud',
    description: 'Renvoie les écritures postérieures au curseur, par ordre chronologique.',
    public: true,
  })
  pull(@Query() query: PullQueryDto) {
    return this.sync.changesSince(query.since, query.limit ?? 200);
  }
}

/**
 * Supervision de la liaison, pour le back-office.
 *
 * Le gérant doit pouvoir répondre à une question simple avant de fermer la
 * caisse : « est-ce que tout est remonté en ligne ? »
 */
@ApiTags('Synchronisation')
@Controller('sync')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class SyncStatusController {
  constructor(private readonly sync: SyncService) {}

  @Get('status')
  @RequirePermissions('SETTINGS_READ')
  @ApiEndpoint({
    summary: 'État de la synchronisation',
    description:
      'Liaison active ou non, écritures en attente, conflits non résolus, date du dernier échange.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['SETTINGS_READ'],
  })
  status() {
    return this.sync.status();
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('SETTINGS_UPDATE')
  @ApiEndpoint({
    summary: 'Déclencher un échange immédiat',
    description:
      "Sans attendre le prochain cycle — utile après une coupure, quand le gérant veut s'assurer que la caisse est remontée.",
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['SETTINGS_UPDATE'],
  })
  run() {
    return this.sync.cycle();
  }
}
