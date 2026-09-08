import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { Permission } from '../constants/permissions.constant';
import { PERMISSIONS_KEY, PERMISSIONS_MODE_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../exceptions/app.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

function makeUser(role: Role, permissions: Permission[] = []): AuthenticatedUser {
  return {
    id: `user-${role}`,
    email: `${role.toLowerCase()}@lebercail.gn`,
    firstName: 'Test',
    lastName: role,
    role,
    status: 'ACTIVE',
    permissions,
    driverProfileId: role === Role.DRIVER ? 'driver-profile-1' : null,
    mustChangePassword: false,
  };
}

function makeContext(user?: AuthenticatedUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** Reflector minimal : renvoie les métadonnées qu'on lui donne. */
function makeReflector(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

/**
 * Ces tests vérifient la matrice d'autorisation annoncée dans le contrat :
 * un rôle sans la permission requise reçoit un refus, quel que soit ce que
 * le frontend croit posséder.
 */
describe('PermissionsGuard', () => {
  it('laisse passer une route sans permission requise', () => {
    const guard = new PermissionsGuard(makeReflector({}));
    expect(guard.canActivate(makeContext(makeUser(Role.CUSTOMER)))).toBe(true);
  });

  it('laisse passer une route publique', () => {
    const guard = new PermissionsGuard(
      makeReflector({ [IS_PUBLIC_KEY]: true, [PERMISSIONS_KEY]: ['ORDERS_READ'] }),
    );
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('accorde tout au SUPER_ADMIN, sans consulter ses permissions', () => {
    const guard = new PermissionsGuard(makeReflector({ [PERMISSIONS_KEY]: ['USERS_PERMISSIONS'] }));
    // Volontairement sans aucune permission dans le jeton : le rôle suffit.
    expect(guard.canActivate(makeContext(makeUser(Role.SUPER_ADMIN, [])))).toBe(true);
  });

  it('refuse un ADMIN dépourvu de la permission exigée', () => {
    const guard = new PermissionsGuard(makeReflector({ [PERMISSIONS_KEY]: ['PAYMENTS_REFUND'] }));
    const admin = makeUser(Role.ADMIN, ['ORDERS_READ', 'MENU_READ']);

    expect(() => guard.canActivate(makeContext(admin))).toThrow(AppException);
    expect(() => guard.canActivate(makeContext(admin))).toThrow(/permissions nécessaires/);
  });

  it('accepte un ADMIN qui détient la permission', () => {
    const guard = new PermissionsGuard(makeReflector({ [PERMISSIONS_KEY]: ['PAYMENTS_REFUND'] }));
    expect(guard.canActivate(makeContext(makeUser(Role.ADMIN, ['PAYMENTS_REFUND'])))).toBe(true);
  });

  it('exige toutes les permissions en mode « all »', () => {
    const guard = new PermissionsGuard(
      makeReflector({
        [PERMISSIONS_KEY]: ['CUSTOMERS_READ', 'ORDERS_READ'],
        [PERMISSIONS_MODE_KEY]: 'all',
      }),
    );

    expect(() => guard.canActivate(makeContext(makeUser(Role.ADMIN, ['CUSTOMERS_READ'])))).toThrow(
      AppException,
    );
    expect(
      guard.canActivate(makeContext(makeUser(Role.ADMIN, ['CUSTOMERS_READ', 'ORDERS_READ']))),
    ).toBe(true);
  });

  it('suffit d’une permission en mode « any »', () => {
    const guard = new PermissionsGuard(
      makeReflector({
        [PERMISSIONS_KEY]: ['USERS_PERMISSIONS', 'USERS_READ'],
        [PERMISSIONS_MODE_KEY]: 'any',
      }),
    );

    expect(guard.canActivate(makeContext(makeUser(Role.ADMIN, ['USERS_READ'])))).toBe(true);
  });

  it('refuse une requête sans utilisateur authentifié', () => {
    const guard = new PermissionsGuard(makeReflector({ [PERMISSIONS_KEY]: ['ORDERS_READ'] }));
    expect(() => guard.canActivate(makeContext())).toThrow(/Authentification requise/);
  });
});

describe('RolesGuard', () => {
  const cases: { role: Role; allowed: Role[]; expected: boolean }[] = [
    { role: Role.CUSTOMER, allowed: [Role.ADMIN, Role.SUPER_ADMIN], expected: false },
    { role: Role.CUSTOMER, allowed: [Role.SUPER_ADMIN], expected: false },
    { role: Role.DRIVER, allowed: [Role.ADMIN, Role.SUPER_ADMIN], expected: false },
    { role: Role.DRIVER, allowed: [Role.SUPER_ADMIN], expected: false },
    { role: Role.ADMIN, allowed: [Role.SUPER_ADMIN], expected: false },
    { role: Role.SUPER_ADMIN, allowed: [Role.ADMIN, Role.SUPER_ADMIN], expected: true },
    { role: Role.CUSTOMER, allowed: [Role.CUSTOMER], expected: true },
    { role: Role.DRIVER, allowed: [Role.DRIVER], expected: true },
  ];

  it.each(cases)(
    'un $role sur une route réservée à $allowed → $expected',
    ({ role, allowed, expected }) => {
      const guard = new RolesGuard(makeReflector({ [ROLES_KEY]: allowed }));
      const context = makeContext(makeUser(role));

      if (expected) {
        expect(guard.canActivate(context)).toBe(true);
      } else {
        expect(() => guard.canActivate(context)).toThrow(AppException);
      }
    },
  );

  it('laisse passer une route sans restriction de rôle', () => {
    const guard = new RolesGuard(makeReflector({}));
    expect(guard.canActivate(makeContext(makeUser(Role.CUSTOMER)))).toBe(true);
  });
});
