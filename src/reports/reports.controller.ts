import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { ApiEndpoint, RequirePermissions, Roles } from '../common/decorators';
import { buildCsv, csvResponse } from '../common/utils/csv.util';
import { DashboardService } from './dashboard.service';
import { ReportsService } from './reports.service';

export class ReportQueryDto {
  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly', 'yearly'], default: 'daily' })
  @IsOptional()
  @IsIn(['daily', 'weekly', 'monthly', 'yearly'])
  period?: string;

  @ApiPropertyOptional({ description: 'Début de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fin de période, ISO 8601.' })
  @IsOptional()
  @IsString()
  to?: string;
}

/**
 * Tableau de bord.
 *
 * `/dashboard` (back-office React) et `/admin/dashboard` (contrat d'API)
 * pointent vers le même contrôleur, comme `/dashboard/super-admin` et
 * `/super-admin/dashboard`.
 */
@ApiTags('Reports')
@Controller(['dashboard', 'admin/dashboard'])
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Tableau de bord opérationnel',
    description:
      "Renvoie en un seul appel : chiffre d'affaires, commandes, commandes en cours par statut, panier moyen, clients actifs, série temporelle, dernières commandes, meilleures ventes et état de la flotte.",
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  admin(@Query() query: ReportQueryDto) {
    return this.dashboard.admin(query);
  }

  @Get('super-admin')
  @Roles(Role.SUPER_ADMIN)
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Tableau de bord de supervision',
    description:
      "Tout le tableau de bord opérationnel, plus : comptes d'administration, utilisateurs actifs sur 24 h, santé technique, alertes de sécurité et journal d'audit récent.",
    roles: [Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  superAdmin(@Query() query: ReportQueryDto) {
    return this.dashboard.superAdmin(query);
  }
}

/** Alias `/super-admin/dashboard` prévu par le contrat d'API. */
@ApiTags('SuperAdmin')
@Controller('super-admin')
@Roles(Role.SUPER_ADMIN)
export class SuperAdminDashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Tableau de bord de supervision',
    roles: [Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  dashboardView(@Query() query: ReportQueryDto) {
    return this.dashboard.superAdmin(query);
  }
}

/**
 * Rapports.
 */
@ApiTags('Reports')
@Controller('reports')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Rapport de période',
    description:
      'Série temporelle, totaux, répartition par moyen de paiement, meilleures ventes, répartition par statut et statistiques de livraison. Agrégations calculées en base.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  report(@Query() query: ReportQueryDto) {
    return this.reports.report(query);
  }

  @Get('sales')
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Rapport de ventes',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  async sales(@Query() query: ReportQueryDto) {
    const range = this.reports.resolveRange(query);
    const [series, totals, topProducts] = await Promise.all([
      this.reports.series(range),
      this.reports.totals(range.from, range.to),
      this.reports.topProducts(range.from, range.to, 20),
    ]);
    return { range, series, totals, topProducts };
  }

  @Get('payments')
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Rapport des encaissements',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  async payments(@Query() query: ReportQueryDto) {
    const range = this.reports.resolveRange(query);
    return {
      range,
      breakdown: await this.reports.paymentBreakdown(range.from, range.to),
    };
  }

  @Get('deliveries')
  @RequirePermissions('REPORTS_READ')
  @ApiEndpoint({
    summary: 'Rapport de livraison',
    description: 'Taux de réussite, délai moyen, volume livré.',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['REPORTS_READ'],
  })
  async deliveries(@Query() query: ReportQueryDto) {
    const range = this.reports.resolveRange(query);
    return {
      range,
      stats: await this.reports.deliveryStats(range.from, range.to),
      fleet: await this.reports.driverOverview(),
    };
  }

  @Get('export')
  @RequirePermissions('REPORTS_EXPORT')
  @ApiEndpoint({
    summary: 'Exporter un rapport (CSV)',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['REPORTS_EXPORT'],
  })
  async export(@Query() query: ReportQueryDto, @Res({ passthrough: true }) response: Response) {
    const report = await this.reports.report(query);

    const csv = buildCsv(report.series, [
      { header: 'Période', value: (row) => row.label },
      { header: 'Date', value: (row) => row.date },
      { header: 'Commandes', value: (row) => row.orders },
      { header: 'Livraisons', value: (row) => row.deliveries },
      { header: "Chiffre d'affaires (GNF)", value: (row) => row.revenue },
    ]);

    return csvResponse(response, 'rapport', csv);
  }
}
