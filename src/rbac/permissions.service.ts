import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  isPermission,
  type Permission,
  type PermissionDefinition,
} from '../common/constants/permissions.constant';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Calcul des permissions effectives.
 *
 *   permissions(user) = socle(role) ∪ accordées(user) − retirées(user)
 *
 * Le SUPER_ADMIN possède l'intégralité du catalogue, sans exception et
 * sans qu'on puisse la lui retirer.
 *
 * Le résultat est mis en cache par utilisateur (courte durée) et invalidé
 * dès qu'un droit change : un retrait de permission prend effet sur la
 * requête suivante, pas à la prochaine reconnexion.
 */
@Injectable()
export class PermissionsService implements OnModuleInit {
  private readonly logger = new Logger(PermissionsService.name);
  private static readonly CACHE_TTL_SECONDS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Le catalogue en base suit celui du code, à chaque démarrage.
   *
   * Les guards lisent la constante, pas la table : une permission absente
   * de la base protège quand même sa route. Mais les ajustements
   * individuels (`user_permissions`) référencent la table — sans cette
   * synchronisation, un SUPER_ADMIN ne pourrait ni accorder ni retirer une
   * permission ajoutée depuis le dernier seed, et son geste serait ignoré
   * en silence.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.syncCatalog();
    } catch (error) {
      // Une base indisponible au démarrage ne doit pas empêcher l'API de
      // se lever : les guards, eux, fonctionnent sans cette table.
      this.logger.error(
        `Synchronisation du catalogue de permissions impossible : ${(error as Error).message}`,
      );
    }
  }

  private cacheKey(userId: string): string {
    return `permissions:user:${userId}`;
  }

  /** Catalogue complet, groupé par module — alimente l'écran React. */
  getCatalog(): {
    modules: { key: string; permissions: PermissionDefinition[] }[];
    permissions: readonly PermissionDefinition[];
    rolePresets: Record<string, readonly Permission[]>;
    superAdminOnly: readonly Permission[];
  } {
    return {
      modules: PERMISSION_MODULES.map((module) => ({
        key: module,
        permissions: PERMISSION_CATALOG.filter((definition) => definition.module === module),
      })),
      permissions: PERMISSION_CATALOG,
      rolePresets: ROLE_PERMISSIONS,
      superAdminOnly: SUPER_ADMIN_ONLY_PERMISSIONS,
    };
  }

  /** Permissions effectives d'un utilisateur. */
  async getEffectivePermissions(userId: string, role: Role): Promise<Permission[]> {
    if (role === Role.SUPER_ADMIN) {
      return [...ROLE_PERMISSIONS.SUPER_ADMIN];
    }

    // Un client ou un livreur n'a aucune permission de back-office :
    // inutile d'interroger la base pour le confirmer à chaque requête.
    if (role === Role.CUSTOMER || role === Role.DRIVER) return [];

    const cached = await this.redis.get<Permission[]>(this.cacheKey(userId));
    if (cached) return cached;

    const overrides = await this.prisma.userPermission.findMany({
      where: { userId },
      include: { permission: { select: { code: true } } },
    });

    const effective = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);

    for (const override of overrides) {
      const code = override.permission.code;
      if (!isPermission(code)) continue;
      if (override.granted) effective.add(code);
      else effective.delete(code);
    }

    // Filet de sécurité : même une donnée corrompue ne peut pas offrir à un
    // ADMIN une permission réservée au SUPER_ADMIN.
    for (const reserved of SUPER_ADMIN_ONLY_PERMISSIONS) {
      effective.delete(reserved);
    }

    const permissions = [...effective];
    await this.redis.set(this.cacheKey(userId), permissions, PermissionsService.CACHE_TTL_SECONDS);
    return permissions;
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(this.cacheKey(userId));
  }

  /**
   * Remplace les permissions individuelles d'un ADMIN.
   *
   * `permissions` est la liste **complète** attendue : le service en
   * déduit ce qu'il faut accorder en plus du socle et ce qu'il faut
   * retirer. Aucune permission réservée au SUPER_ADMIN n'est délégable.
   */
  async setUserPermissions(userId: string, role: Role, permissions: string[]): Promise<Permission[]> {
    if (role === Role.SUPER_ADMIN) {
      throw AppException.forbidden(
        ERROR_CODES.CANNOT_MODIFY_SUPER_ADMIN,
        "Les permissions d'un SUPER_ADMIN ne se modifient pas : il les possède toutes.",
      );
    }

    const requested = new Set<Permission>();
    for (const code of permissions) {
      if (!isPermission(code)) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          `Permission inconnue : ${code}.`,
        );
      }
      if (SUPER_ADMIN_ONLY_PERMISSIONS.includes(code)) {
        throw AppException.forbidden(
          ERROR_CODES.PERMISSION_NOT_DELEGABLE,
          `La permission ${code} est réservée au SUPER_ADMIN et ne peut pas être déléguée.`,
        );
      }
      requested.add(code);
    }

    const base = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
    const catalog = await this.prisma.permission.findMany({ select: { id: true, code: true } });
    const idByCode = new Map(catalog.map((entry) => [entry.code, entry.id]));

    const overrides: { permissionId: string; granted: boolean }[] = [];

    for (const permission of requested) {
      if (!base.has(permission)) {
        const id = idByCode.get(permission);
        if (id) overrides.push({ permissionId: id, granted: true });
      }
    }

    for (const permission of base) {
      if (!requested.has(permission)) {
        const id = idByCode.get(permission);
        if (id) overrides.push({ permissionId: id, granted: false });
      }
    }

    await this.prisma.transaction(async (tx) => {
      await tx.userPermission.deleteMany({ where: { userId } });
      if (overrides.length > 0) {
        await tx.userPermission.createMany({
          data: overrides.map((override) => ({ ...override, userId })),
        });
      }
    });

    await this.invalidate(userId);
    this.logger.log(`Permissions mises à jour pour l'utilisateur ${userId}.`);

    return [...requested];
  }

  /** Vérification impérative, pour les règles métier hors guard. */
  async assertHasPermission(userId: string, role: Role, permission: Permission): Promise<void> {
    if (role === Role.SUPER_ADMIN) return;
    const permissions = await this.getEffectivePermissions(userId, role);
    if (!permissions.includes(permission)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        "Vous n'avez pas les permissions nécessaires.",
        { required: [permission] },
      );
    }
  }

  /** Synchronise le catalogue en base (idempotent, appelé au démarrage). */
  async syncCatalog(): Promise<void> {
    for (const definition of PERMISSION_CATALOG) {
      await this.prisma.permission.upsert({
        where: { code: definition.code },
        update: {
          module: definition.module,
          label: definition.label,
          description: definition.description,
          isSensitive: definition.sensitive,
        },
        create: {
          code: definition.code,
          module: definition.module,
          label: definition.label,
          description: definition.description,
          isSensitive: definition.sensitive,
        },
      });
    }

    const stored = await this.prisma.permission.findMany({ select: { id: true, code: true } });
    const idByCode = new Map(stored.map((entry) => [entry.code, entry.id]));

    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const code of permissions) {
        const permissionId = idByCode.get(code);
        if (!permissionId) continue;
        await this.prisma.rolePermission.upsert({
          where: { role_permissionId: { role: role as Role, permissionId } },
          update: {},
          create: { role: role as Role, permissionId },
        });
      }
    }
  }
}
