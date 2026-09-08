import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import {
  CreateExpenseDto,
  CreateIncomeDto,
  ExpenseQueryDto,
  IncomeQueryDto,
  SettleExpenseDto,
  UpdateExpenseDto,
  UpdateIncomeDto,
} from './dto/expense.dto';
import { ExpensesService } from './expenses.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Dépenses — factures, charges, salaires, achats.
 */
@ApiTags('Dépenses')
@Controller('expenses')
@Roles(...BACK_OFFICE)
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Lister les dépenses',
    description:
      'Toutes les sorties d’argent, achats de marchandises compris. La page porte aussi les totaux du filtre appliqué.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
    paginated: true,
  })
  list(@Query() query: ExpenseQueryDto) {
    return this.expenses.list(query);
  }

  @Get('due')
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Charges à régler',
    description: 'Factures en attente dont l’échéance approche ou est dépassée.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
  })
  due() {
    return this.expenses.dueSoon();
  }

  @Get(':id')
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Détail d’une dépense',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.expenses.findOne(id);
  }

  @Post()
  @RequirePermissions('EXPENSES_MANAGE')
  @ApiEndpoint({
    summary: 'Enregistrer une dépense',
    roles: [...BACK_OFFICE],
    permissions: ['EXPENSES_MANAGE'],
  })
  create(
    @Body() dto: CreateExpenseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.create(dto, user, context);
  }

  @Patch(':id')
  @RequirePermissions('EXPENSES_MANAGE')
  @ApiEndpoint({
    summary: 'Modifier une dépense',
    roles: [...BACK_OFFICE],
    permissions: ['EXPENSES_MANAGE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.update(id, dto, user, context);
  }

  @Patch(':id/settle')
  @RequirePermissions('EXPENSES_MANAGE')
  @ApiEndpoint({
    summary: 'Marquer une charge comme réglée',
    roles: [...BACK_OFFICE],
    permissions: ['EXPENSES_MANAGE'],
  })
  settle(
    @Param('id') id: string,
    @Body() dto: SettleExpenseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.settle(id, dto, user, context);
  }

  @Delete(':id')
  @RequirePermissions('EXPENSES_MANAGE')
  @ApiEndpoint({
    summary: 'Supprimer une dépense (logique)',
    roles: [...BACK_OFFICE],
    permissions: ['EXPENSES_MANAGE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.remove(id, user, context);
  }
}

/**
 * Recettes hors vente.
 */
@ApiTags('Recettes')
@Controller('incomes')
@Roles(...BACK_OFFICE)
export class IncomesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermissions('FINANCE_READ')
  @ApiEndpoint({
    summary: 'Lister les recettes diverses',
    description: 'Entrées d’argent qui ne proviennent pas d’une commande.',
    roles: [...BACK_OFFICE],
    permissions: ['FINANCE_READ'],
    paginated: true,
  })
  list(@Query() query: IncomeQueryDto) {
    return this.expenses.listIncomes(query);
  }

  @Post()
  @RequirePermissions('INCOMES_MANAGE')
  @ApiEndpoint({
    summary: 'Enregistrer une recette',
    roles: [...BACK_OFFICE],
    permissions: ['INCOMES_MANAGE'],
  })
  create(
    @Body() dto: CreateIncomeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.createIncome(dto, user, context);
  }

  @Patch(':id')
  @RequirePermissions('INCOMES_MANAGE')
  @ApiEndpoint({
    summary: 'Modifier une recette',
    roles: [...BACK_OFFICE],
    permissions: ['INCOMES_MANAGE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIncomeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.updateIncome(id, dto, user, context);
  }

  @Delete(':id')
  @RequirePermissions('INCOMES_MANAGE')
  @ApiEndpoint({
    summary: 'Supprimer une recette (logique)',
    roles: [...BACK_OFFICE],
    permissions: ['INCOMES_MANAGE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.expenses.removeIncome(id, user, context);
  }
}
