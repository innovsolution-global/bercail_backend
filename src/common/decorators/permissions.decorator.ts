import { applyDecorators, SetMetadata } from '@nestjs/common';
import type { Permission } from '../constants/permissions.constant';

export const PERMISSIONS_KEY = 'permissions';
export const PERMISSIONS_MODE_KEY = 'permissionsMode';

export type PermissionsMode = 'all' | 'any';

/**
 * Exige une ou plusieurs permissions.
 *
 * Par défaut, **toutes** les permissions listées sont requises. Le
 * SUPER_ADMIN les possède toutes par construction.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'all' as PermissionsMode),
  );

/** Variante « au moins une des permissions ». */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'any' as PermissionsMode),
  );
