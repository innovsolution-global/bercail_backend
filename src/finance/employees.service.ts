import { Injectable } from '@nestjs/common';
import {
  ContractType,
  Employee,
  EmployeeStatus,
  ExpenseCategory,
  ExpenseStatus,
  FinancePaymentMethod,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { generateDocumentReference } from '../common/utils/reference.util';
import { parseEnum, toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import type {
  CreateEmployeeDto,
  EmployeeQueryDto,
  GeneratePayrollDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { ExpensesService } from './expenses.service';

/** Bornes du mois `AAAA-MM`, en UTC. */
function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

/**
 * Personnel et paie.
 *
 * Les salaires ne forment pas un registre à part : chaque paie est une
 * dépense de catégorie SALAIRE rattachée à un employé et à un mois. Le
 * rapport d'activité les additionne donc naturellement avec le reste des
 * charges, sans traitement particulier.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expenses: ExpensesService,
    private readonly audit: AuditService,
    private readonly scope: RestaurantScopeService,
  ) {}

  async list(query: EmployeeQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.EmployeeWhereInput = { deletedAt: null };

    const status = parseEnum(EmployeeStatus, query.status);
    if (status) where.status = status;

    const contractType = parseEnum(ContractType, query.contractType);
    if (contractType) where.contractType = contractType;

    if (query.position && query.position !== 'all') {
      where.position = { equals: query.position, mode: 'insensitive' };
    }

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
        { position: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total, payroll] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        orderBy: [{ status: 'asc' }, { lastName: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.employee.count({ where }),
      this.prisma.employee.aggregate({
        where: { deletedAt: null, status: EmployeeStatus.ACTIVE },
        _sum: { baseSalary: true },
        _count: true,
      }),
    ]);

    const result = paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);

    return {
      ...result,
      meta: {
        ...result.meta,
        activeCount: payroll._count,
        monthlyPayroll: payroll._sum.baseSalary ?? 0,
      },
    } as PaginatedResult<unknown>;
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findFirst({ where: { id, deletedAt: null } });
    if (!employee) throw AppException.notFound('Employé introuvable.');

    const salaries = await this.prisma.expense.findMany({
      where: { employeeId: id, category: ExpenseCategory.SALAIRE, deletedAt: null },
      orderBy: { incurredAt: 'desc' },
      take: 24,
      include: {
        supplier: { select: { id: true, name: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
        purchase: { select: { id: true, reference: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    const paid = salaries
      .filter((salary) => salary.status === ExpenseStatus.PAID)
      .reduce((total, salary) => total + salary.amount, 0);

    return {
      ...this.toDto(employee),
      totalPaid: paid,
      salaries: salaries.map((salary) => this.expenses.toDto(salary)),
    };
  }

  /** Postes déjà utilisés — alimente le filtre et l'autocomplétion. */
  async positions() {
    const rows = await this.prisma.employee.groupBy({
      by: ['position'],
      where: { deletedAt: null },
      _count: true,
      orderBy: { position: 'asc' },
    });
    return rows.map((row) => ({ position: row.position, count: row._count }));
  }

  async create(dto: CreateEmployeeDto, actor: AuthenticatedUser, context: RequestContext) {
    if (dto.userId) {
      const linked = await this.prisma.employee.findUnique({ where: { userId: dto.userId } });
      if (linked) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'Ce compte est déjà rattaché à un employé.',
        );
      }
    }

    const employee = await this.prisma.employee.create({
      data: {
        restaurantId: this.scope.resolve(dto.restaurantId),
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        address: dto.address ?? null,
        position: dto.position.trim(),
        contractType: (parseEnum(ContractType, dto.contractType) ??
          ContractType.CDI) as ContractType,
        status: (parseEnum(EmployeeStatus, dto.status) ?? EmployeeStatus.ACTIVE) as EmployeeStatus,
        baseSalary: dto.baseSalary,
        hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : new Date(),
        endedAt: dto.endedAt ? new Date(dto.endedAt) : null,
        userId: dto.userId ?? null,
        note: dto.note ?? null,
      },
    });

    await this.audit.record({
      actor,
      action: 'EMPLOYEE_CREATE',
      module: 'hr',
      entityType: 'Employee',
      entityId: employee.id,
      newValue: {
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        position: employee.position,
        baseSalary: employee.baseSalary,
      },
      context,
    });

    return this.toDto(employee);
  }

  async update(
    id: string,
    dto: UpdateEmployeeDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const existing = await this.prisma.employee.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Employé introuvable.');

    const employee = await this.prisma.employee.update({
      where: { id },
      data: {
        firstName: dto.firstName?.trim(),
        lastName: dto.lastName?.trim(),
        phone: dto.phone,
        email: dto.email,
        address: dto.address,
        position: dto.position?.trim(),
        contractType: parseEnum(ContractType, dto.contractType),
        status: parseEnum(EmployeeStatus, dto.status),
        baseSalary: dto.baseSalary,
        hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : undefined,
        endedAt: dto.endedAt ? new Date(dto.endedAt) : undefined,
        userId: dto.userId,
        note: dto.note,
      },
    });

    await this.audit.record({
      actor,
      action: 'EMPLOYEE_UPDATE',
      module: 'hr',
      entityType: 'Employee',
      entityId: id,
      oldValue: { baseSalary: existing.baseSalary, status: existing.status },
      newValue: { baseSalary: employee.baseSalary, status: employee.status },
      context,
    });

    return this.toDto(employee);
  }

  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.employee.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Employé introuvable.');

    await this.prisma.employee.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: EmployeeStatus.TERMINATED,
        endedAt: existing.endedAt ?? new Date(),
      },
    });

    await this.audit.record({
      actor,
      action: 'EMPLOYEE_DELETE',
      module: 'hr',
      entityType: 'Employee',
      entityId: id,
      oldValue: { name: `${existing.firstName} ${existing.lastName}`.trim() },
      context,
    });

    return { success: true };
  }

  // ──────────────────────────────── Paie ──────────────────────────────────

  /** État de la paie d'un mois : qui est payé, qui ne l'est pas encore. */
  async payroll(period: string) {
    const [employees, salaries] = await Promise.all([
      this.prisma.employee.findMany({
        where: { deletedAt: null, status: EmployeeStatus.ACTIVE },
        orderBy: [{ lastName: 'asc' }],
      }),
      this.prisma.expense.findMany({
        where: { category: ExpenseCategory.SALAIRE, period, deletedAt: null },
      }),
    ]);

    const salaryByEmployee = new Map(
      salaries.filter((salary) => salary.employeeId).map((salary) => [salary.employeeId!, salary]),
    );

    const lines = employees.map((employee) => {
      const salary = salaryByEmployee.get(employee.id);
      return {
        employeeId: employee.id,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        position: employee.position,
        baseSalary: employee.baseSalary,
        expenseId: salary?.id ?? null,
        reference: salary?.reference ?? null,
        amount: salary?.amount ?? employee.baseSalary,
        status: salary ? toWire(salary.status) : 'not_generated',
        paidAt: salary?.paidAt?.toISOString() ?? null,
      };
    });

    return {
      period,
      lines,
      totals: {
        headcount: employees.length,
        expected: employees.reduce((total, employee) => total + employee.baseSalary, 0),
        generated: lines.filter((line) => line.expenseId).length,
        paid: salaries
          .filter((salary) => salary.status === ExpenseStatus.PAID)
          .reduce((total, salary) => total + salary.amount, 0),
        pending: salaries
          .filter((salary) => salary.status === ExpenseStatus.PENDING)
          .reduce((total, salary) => total + salary.amount, 0),
      },
    };
  }

  /**
   * Génère les salaires du mois.
   *
   * Rejouer l'opération ne crée pas de doublon : un employé qui a déjà sa
   * ligne pour la période est simplement ignoré. C'est ce qui permet de
   * relancer la génération après avoir embauché quelqu'un en cours de mois.
   */
  async generatePayroll(
    dto: GeneratePayrollDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const { end } = periodBounds(dto.period);

    const employees = await this.prisma.employee.findMany({
      where: {
        deletedAt: null,
        status: EmployeeStatus.ACTIVE,
        baseSalary: { gt: 0 },
        ...(dto.employeeIds?.length ? { id: { in: dto.employeeIds } } : {}),
      },
    });

    if (employees.length === 0) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Aucun employé actif avec un salaire à générer.',
      );
    }

    const existing = await this.prisma.expense.findMany({
      where: {
        category: ExpenseCategory.SALAIRE,
        period: dto.period,
        deletedAt: null,
        employeeId: { in: employees.map((employee) => employee.id) },
      },
      select: { employeeId: true },
    });
    const alreadyPaid = new Set(existing.map((row) => row.employeeId));

    const toGenerate = employees.filter((employee) => !alreadyPaid.has(employee.id));
    const paymentMethod = (parseEnum(FinancePaymentMethod, dto.paymentMethod) ??
      FinancePaymentMethod.CASH) as FinancePaymentMethod;
    const status = dto.markPaid ? ExpenseStatus.PAID : ExpenseStatus.PENDING;

    // Le mois de paie est daté de son dernier jour : un salaire d'août
    // reste dans le rapport d'août, même généré en septembre.
    const created = await this.prisma.transaction(async (tx) => {
      const rows = [];
      for (const employee of toGenerate) {
        rows.push(
          await tx.expense.create({
            data: {
              // La paie appartient à l'établissement de l'employé payé.
              restaurantId: employee.restaurantId,
              reference: generateDocumentReference('SAL', end),
              label: `Salaire ${dto.period} — ${employee.firstName} ${employee.lastName}`.trim(),
              category: ExpenseCategory.SALAIRE,
              amount: employee.baseSalary,
              status,
              paymentMethod,
              incurredAt: end,
              paidAt: status === ExpenseStatus.PAID ? end : null,
              period: dto.period,
              employeeId: employee.id,
              createdById: actor.id,
            },
          }),
        );
      }
      return rows;
    });

    await this.audit.record({
      actor,
      action: 'PAYROLL_GENERATE',
      module: 'hr',
      entityType: 'Expense',
      newValue: {
        period: dto.period,
        generated: created.length,
        skipped: employees.length - created.length,
        total: created.reduce((total, row) => total + row.amount, 0),
      },
      context,
    });

    return {
      period: dto.period,
      generated: created.length,
      skipped: employees.length - created.length,
      totalAmount: created.reduce((total, row) => total + row.amount, 0),
    };
  }

  private toDto(employee: Employee) {
    return {
      id: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      fullName: `${employee.firstName} ${employee.lastName}`.trim(),
      phone: employee.phone,
      email: employee.email,
      address: employee.address,
      position: employee.position,
      contractType: toWire(employee.contractType),
      status: toWire(employee.status),
      baseSalary: employee.baseSalary,
      hiredAt: employee.hiredAt.toISOString(),
      endedAt: employee.endedAt?.toISOString() ?? null,
      userId: employee.userId,
      note: employee.note,
      createdAt: employee.createdAt.toISOString(),
    };
  }
}
