import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AuditResult, Role } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { ApiEndpoint, RequirePermissions, Roles } from '../common/decorators';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { buildCsv, csvResponse } from '../common/utils/csv.util';
import { parseEnum } from '../common/utils/wire-enum.util';
import { AuditService } from './audit.service';

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filtrer par auteur.' })
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({ enum: ['ADMIN', 'SUPER_ADMIN', 'CUSTOMER', 'DRIVER', 'all'] })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ description: "Action exacte, ex. ORDER_CANCEL." })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Module concerné, ex. orders.' })
  @IsOptional()
  @IsString()
  module?: string;

  @ApiPropertyOptional({ enum: ['success', 'failure', 'all'] })
  @IsOptional()
  @IsString()
  result?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;
}

/**
 * Journal d'audit.
 *
 * Lecture seule, réservée au SUPER_ADMIN (ou à un ADMIN à qui la
 * permission a été explicitement déléguée). Aucune route ne permet de
 * modifier ni de supprimer une entrée : un journal que l'on peut réécrire
 * ne sert à rien.
 *
 * Deux chemins : `/audit-logs` (back-office) et `/super-admin/audit-logs`
 * (contrat d'API).
 */
@ApiTags('Audit')
@Controller(['audit-logs', 'super-admin/audit-logs'])
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('AUDIT_READ')
  @ApiEndpoint({
    summary: "Consulter le journal d'audit",
    description: 'Pagination, recherche et filtres : auteur, rôle, action, module, résultat, période.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['AUDIT_READ'],
    paginated: true,
  })
  list(@Query() query: AuditQueryDto) {
    return this.audit.list({
      page: query.page,
      limit: query.limit,
      search: query.search,
      actorId: query.actorId && query.actorId !== 'all' ? query.actorId : undefined,
      role: parseEnum(Role, query.role) as Role | undefined,
      action: query.action && query.action !== 'all' ? query.action : undefined,
      module: query.module && query.module !== 'all' ? query.module : undefined,
      result: parseEnum(AuditResult, query.result) as AuditResult | undefined,
      from: query.from,
      to: query.to,
    });
  }

  @Get('actions')
  @RequirePermissions('AUDIT_READ')
  @ApiEndpoint({
    summary: 'Actions présentes dans le journal',
    description: 'Alimente le filtre « action » sans charger les entrées.',
    roles: [Role.SUPER_ADMIN],
    permissions: ['AUDIT_READ'],
  })
  actions() {
    return this.audit.distinctActions();
  }

  @Get('modules')
  @RequirePermissions('AUDIT_READ')
  @ApiEndpoint({
    summary: 'Modules présents dans le journal',
    roles: [Role.SUPER_ADMIN],
    permissions: ['AUDIT_READ'],
  })
  modules() {
    return this.audit.distinctModules();
  }

  @Get('export')
  @RequirePermissions('AUDIT_EXPORT')
  @ApiEndpoint({
    summary: "Exporter le journal d'audit (CSV)",
    roles: [Role.SUPER_ADMIN],
    permissions: ['AUDIT_EXPORT'],
  })
  async export(@Query() query: AuditQueryDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.audit.list({
      page: 1,
      limit: 100,
      search: query.search,
      actorId: query.actorId && query.actorId !== 'all' ? query.actorId : undefined,
      role: parseEnum(Role, query.role) as Role | undefined,
      action: query.action && query.action !== 'all' ? query.action : undefined,
      module: query.module && query.module !== 'all' ? query.module : undefined,
      result: parseEnum(AuditResult, query.result) as AuditResult | undefined,
      from: query.from,
      to: query.to,
    });

    const csv = buildCsv(result.data, [
      { header: 'Date', value: (row) => String(row.at ?? '') },
      { header: 'Auteur', value: (row) => String(row.actorName ?? '') },
      { header: 'Rôle', value: (row) => String(row.actorRole ?? '') },
      { header: 'Action', value: (row) => String(row.action ?? '') },
      { header: 'Module', value: (row) => String(row.module ?? '') },
      { header: 'Entité', value: (row) => String(row.entityType ?? '') },
      { header: 'Identifiant', value: (row) => String(row.entityId ?? '') },
      { header: 'Résultat', value: (row) => String(row.result ?? '') },
      { header: 'Adresse IP', value: (row) => String(row.ipAddress ?? '') },
    ]);

    return csvResponse(response, 'journal-audit', csv);
  }
}
