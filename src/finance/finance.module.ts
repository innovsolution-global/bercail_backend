import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { ExpensesController, IncomesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { FinanceReportController } from './finance-report.controller';
import { FinanceReportService } from './finance-report.service';
import { PurchasesService } from './purchases.service';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { PurchasesController, StockController, SuppliersController } from './stock.controller';
import { StockService } from './stock.service';
import { SuppliersService } from './suppliers.service';

/**
 * Gestion d'exploitation.
 *
 * Un seul module pour l'argent, le stock et le personnel : ces trois
 * registres se répondent en permanence (un achat entre en stock et sort de
 * la caisse, un salaire est une charge du mois), les séparer aurait
 * multiplié les dépendances croisées sans rien clarifier.
 */
@Module({
  controllers: [
    SuppliersController,
    StockController,
    PurchasesController,
    ExpensesController,
    IncomesController,
    EmployeesController,
    FinanceReportController,
    RecipesController,
  ],
  providers: [
    SuppliersService,
    StockService,
    PurchasesService,
    ExpensesService,
    EmployeesService,
    FinanceReportService,
    RecipesService,
  ],
  exports: [StockService, ExpensesService, FinanceReportService, RecipesService],
})
export class FinanceModule {}
