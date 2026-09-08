import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { ApiEndpoint, RequirePermissions, Roles } from '../common/decorators';
import { buildCsv, csvResponse } from '../common/utils/csv.util';
import { formatAmount } from '../common/utils/money.util';
import { FinanceRangeQueryDto, LedgerQueryDto, PeriodQueryDto } from './dto/common.dto';
import { FinanceReportService } from './finance-report.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Rapport d'activité.
 *
 * Un seul endroit répond à la question du propriétaire : « ce mois-ci,
 * combien est entré, combien est sorti, combien reste-t-il ? »
 */
@ApiTags('Gestion financière')
@Controller('finance')
@Roles(...BACK_OFFICE)
export class FinanceReportController {
  constructor(private readonly finance: FinanceReportService) {}

  @Get('summary')
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Synthèse financière d’une période',
    description: 'Recettes (ventes en ligne et au comptoir, recettes diverses), dépenses, résultat.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
  })
  async summary(@Query() query: FinanceRangeQueryDto) {
    const range = this.finance.resolveRange(query);
    return this.finance.summary(range.from, range.to);
  }

  @Get('overview')
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Tableau de bord financier',
    description:
      'Synthèse, série recettes/dépenses, répartition des charges et principaux fournisseurs, en un seul appel.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
  })
  async overview(@Query() query: FinanceRangeQueryDto) {
    const range = this.finance.resolveRange(query);

    const [summary, series, expensesByCategory, topSuppliers] = await Promise.all([
      this.finance.summary(range.from, range.to),
      this.finance.series(range),
      this.finance.expensesByCategory(range.from, range.to),
      this.finance.topSuppliers(range.from, range.to),
    ]);

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        granularity: range.granularity,
      },
      summary,
      series,
      expensesByCategory,
      topSuppliers,
    };
  }

  @Get('ledger')
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Journal de caisse',
    description:
      'Ventes, recettes et dépenses sur une même ligne de temps. La page porte le total des entrées, des sorties et le solde.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
    paginated: true,
  })
  ledger(@Query() query: LedgerQueryDto) {
    const range = this.finance.resolveRange(query);
    return this.finance.ledger({
      from: range.from,
      to: range.to,
      direction: query.direction === 'all' ? undefined : query.direction,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('monthly-report')
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Rapport d’activité mensuel',
    description:
      'Recettes, charges, résultat, comparaison avec le mois précédent, répartition des dépenses, meilleures ventes et masse salariale.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
  })
  monthlyReport(@Query() query: PeriodQueryDto) {
    return this.finance.monthlyReport(query.period);
  }

  @Get('monthly-report/export')
  @RequirePermissions('FINANCE_EXPORT')
  @ApiEndpoint({
    summary: 'Exporter le rapport mensuel (CSV)',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_EXPORT'],
  })
  async exportMonthlyReport(
    @Query() query: PeriodQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const report = await this.finance.monthlyReport(query.period);

    // Une seule feuille, lue de haut en bas comme un compte de résultat.
    const rows: { section: string; label: string; amount: number }[] = [
      { section: 'Recettes', label: 'Ventes en ligne', amount: report.summary.income.salesOnline },
      { section: 'Recettes', label: 'Ventes au comptoir', amount: report.summary.income.salesPos },
      { section: 'Recettes', label: 'Recettes diverses', amount: report.summary.income.otherIncome },
      { section: 'Recettes', label: 'Total des recettes', amount: report.summary.income.total },
      ...report.expensesByCategory.map((entry) => ({
        section: 'Dépenses',
        label: entry.category,
        amount: entry.amount,
      })),
      { section: 'Dépenses', label: 'Total des dépenses', amount: report.summary.expenses.total },
      { section: 'Résultat', label: 'Résultat net', amount: report.summary.result.net },
      { section: 'Stock', label: 'Valeur du stock', amount: report.summary.stock.value },
    ];

    const csv = buildCsv(rows, [
      { header: 'Période', value: () => report.label },
      { header: 'Rubrique', value: (row) => row.section },
      { header: 'Poste', value: (row) => row.label },
      { header: 'Montant (GNF)', value: (row) => row.amount },
      { header: 'Montant formaté', value: (row) => formatAmount(row.amount) },
    ]);

    return csvResponse(response, `rapport-activite-${report.period}`, csv);
  }

  @Get('ledger/export')
  @RequirePermissions('FINANCE_EXPORT')
  @ApiEndpoint({
    summary: 'Exporter le journal de caisse (CSV)',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_EXPORT'],
  })
  async exportLedger(
    @Query() query: LedgerQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const range = this.finance.resolveRange(query);

    // L'export ne pagine pas : c'est un document comptable, il doit être
    // complet. Le plafond protège la mémoire du serveur.
    const ledger = (await this.finance.ledger({
      from: range.from,
      to: range.to,
      direction: query.direction === 'all' ? undefined : query.direction,
      page: 1,
      limit: 5000,
    })) as {
      data: {
        occurredAt: string;
        direction: string;
        kind: string;
        reference: string;
        label: string;
        category: string;
        amount: number;
        method: string;
        status: string;
      }[];
    };

    const csv = buildCsv(ledger.data, [
      { header: 'Date', value: (row) => row.occurredAt.slice(0, 10) },
      { header: 'Sens', value: (row) => (row.direction === 'in' ? 'Entrée' : 'Sortie') },
      { header: 'Nature', value: (row) => row.kind },
      { header: 'Référence', value: (row) => row.reference },
      { header: 'Libellé', value: (row) => row.label },
      { header: 'Catégorie', value: (row) => row.category },
      { header: 'Montant (GNF)', value: (row) => row.amount },
      { header: 'Règlement', value: (row) => row.method },
      { header: 'État', value: (row) => row.status },
    ]);

    return csvResponse(response, 'journal-de-caisse', csv);
  }
}
