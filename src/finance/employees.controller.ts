import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import {
  CreateEmployeeDto,
  EmployeeQueryDto,
  GeneratePayrollDto,
  PayrollQueryDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { EmployeesService } from './employees.service';
import { FinanceReportService } from './finance-report.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Personnel et paie.
 */
@ApiTags('Personnel')
@Controller('employees')
@Roles(...BACK_OFFICE)
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly report: FinanceReportService,
  ) {}

  @Get()
  @RequirePermissions('EMPLOYEES_READ')
  @ApiEndpoint({
    summary: 'Lister le personnel',
    description: 'La page porte aussi l’effectif actif et la masse salariale mensuelle.',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_READ'],
    paginated: true,
  })
  list(@Query() query: EmployeeQueryDto) {
    return this.employees.list(query);
  }

  @Get('positions')
  @RequirePermissions('EMPLOYEES_READ')
  @ApiEndpoint({
    summary: 'Postes occupés',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_READ'],
  })
  positions() {
    return this.employees.positions();
  }

  @Get('payroll')
  @RequirePermissions('EMPLOYEES_READ')
  @ApiEndpoint({
    summary: 'Paie du mois',
    description:
      'Pour chaque employé actif : le salaire attendu, la ligne générée s’il y en a une, et son état de règlement.',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_READ'],
  })
  payroll(@Query() query: PayrollQueryDto) {
    return this.employees.payroll(this.report.resolvePeriod(query.period).period);
  }

  @Post('payroll/generate')
  @RequirePermissions('PAYROLL_MANAGE')
  @ApiEndpoint({
    summary: 'Générer la paie du mois',
    description:
      'Crée une dépense de salaire par employé actif. Rejouer l’opération ne crée pas de doublon.',
    roles: [...BACK_OFFICE],
    permissions: ['PAYROLL_MANAGE'],
  })
  generatePayroll(
    @Body() dto: GeneratePayrollDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.employees.generatePayroll(dto, user, context);
  }

  @Get(':id')
  @RequirePermissions('EMPLOYEES_READ')
  @ApiEndpoint({
    summary: 'Fiche d’un employé',
    description: 'Inclut les 24 derniers salaires versés.',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.employees.findOne(id);
  }

  @Post()
  @RequirePermissions('EMPLOYEES_MANAGE')
  @ApiEndpoint({
    summary: 'Ajouter un employé',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_MANAGE'],
  })
  create(
    @Body() dto: CreateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.employees.create(dto, user, context);
  }

  @Patch(':id')
  @RequirePermissions('EMPLOYEES_MANAGE')
  @ApiEndpoint({
    summary: 'Modifier un employé',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_MANAGE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.employees.update(id, dto, user, context);
  }

  @Delete(':id')
  @RequirePermissions('EMPLOYEES_MANAGE')
  @ApiEndpoint({
    summary: 'Sortir un employé des effectifs',
    description: 'Suppression logique : les salaires déjà versés restent au journal.',
    roles: [...BACK_OFFICE],
    permissions: ['EMPLOYEES_MANAGE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.employees.remove(id, user, context);
  }
}
