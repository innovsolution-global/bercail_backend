import { AccountStatus, DriverProfile, Prisma, Role, User } from '@prisma/client';
import type { Permission } from '../common/constants/permissions.constant';
import { toWire } from '../common/utils/wire-enum.util';

/**
 * Sérialisation des utilisateurs.
 *
 * Un seul endroit décide de ce qui sort de l'API pour un utilisateur.
 * Le `passwordHash`, les jetons et les compteurs de sécurité ne sont
 * jamais exposés : ils ne sont même pas sélectionnés dans les requêtes.
 */

export type UserWithProfiles = User & {
  driverProfile?: DriverProfile | null;
  customerProfile?: {
    loyaltyPoints: number;
    ordersCount: number;
    cancelledOrders: number;
    totalSpent: number;
    lastOrderAt: Date | null;
  } | null;
};

/** Champs sûrs à sélectionner partout où un utilisateur est renvoyé. */
export const PUBLIC_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  avatarUrl: true,
  lastLoginAt: true,
  createdAt: true,
  createdById: true,
} satisfies Prisma.UserSelect;

export function fullName(user: { firstName: string; lastName: string }): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export interface AdminUserDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  role: Role;
  status: string;
  permissions: Permission[];
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Forme attendue par le back-office React (`AdminUser`). */
export function toAdminUser(
  user: Pick<
    User,
    | 'id'
    | 'firstName'
    | 'lastName'
    | 'email'
    | 'phone'
    | 'role'
    | 'status'
    | 'avatarUrl'
    | 'lastLoginAt'
    | 'createdAt'
    | 'createdById'
  >,
  permissions: Permission[] = [],
): AdminUserDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: fullName(user),
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: toWire(user.status),
    permissions,
    avatarUrl: user.avatarUrl ?? null,
    lastLoginAt: iso(user.lastLoginAt),
    createdAt: user.createdAt.toISOString(),
    createdBy: user.createdById ?? null,
  };
}

export interface AuthUserDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  role: Role;
  status: string;
  avatarUrl: string | null;
  permissions: Permission[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Présent uniquement pour un DRIVER. */
  driver?: {
    id: string;
    driverCode: string;
    vehicleType: string;
    plateNumber: string | null;
    zone: string;
    isOnline: boolean;
    isAvailable: boolean;
    rating: number;
    completedDeliveries: number;
  };
  /** Présent uniquement pour un CUSTOMER. */
  customer?: {
    loyaltyPoints: number;
    ordersCount: number;
    totalSpent: number;
    lastOrderAt: string | null;
  };
}

/**
 * Utilisateur renvoyé par `/auth/me` et par `/auth/login`.
 * La même route sert les quatre rôles : le contenu s'adapte, le contrat
 * reste unique — c'est ce qui permet à Flutter et React de partager l'API.
 */
export function toAuthUser(user: UserWithProfiles, permissions: Permission[] = []): AuthUserDto {
  const dto: AuthUserDto = {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: fullName(user),
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: toWire(user.status),
    avatarUrl: user.avatarUrl ?? null,
    permissions,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: iso(user.lastLoginAt),
    createdAt: user.createdAt.toISOString(),
  };

  if (user.role === Role.DRIVER && user.driverProfile) {
    dto.driver = {
      id: user.driverProfile.id,
      driverCode: user.driverProfile.driverCode,
      vehicleType: toWire(user.driverProfile.vehicleType),
      plateNumber: user.driverProfile.plateNumber ?? null,
      zone: user.driverProfile.zone,
      isOnline: user.driverProfile.isOnline,
      isAvailable: user.driverProfile.isAvailable,
      rating: user.driverProfile.rating,
      completedDeliveries: user.driverProfile.completedDeliveries,
    };
  }

  if (user.role === Role.CUSTOMER && user.customerProfile) {
    dto.customer = {
      loyaltyPoints: user.customerProfile.loyaltyPoints,
      ordersCount: user.customerProfile.ordersCount,
      totalSpent: user.customerProfile.totalSpent,
      lastOrderAt: iso(user.customerProfile.lastOrderAt),
    };
  }

  return dto;
}

export function isBackOfficeRole(role: Role): boolean {
  return role === Role.ADMIN || role === Role.SUPER_ADMIN;
}

export function statusFromWire(value: string): AccountStatus {
  return value.toUpperCase() as AccountStatus;
}
