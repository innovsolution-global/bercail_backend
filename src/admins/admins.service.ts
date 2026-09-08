import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  AuthTokenPurpose,
  NotificationType,
  Prisma,
  Role,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { randomPassword, randomToken, sha256 } from '../common/utils/crypto.util';
import { parseEnum } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { MailService } from '../mail/mail.service';
import {
  accountCreatedWithActivationLink,
  accountCreatedWithPassword,
} from '../mail/mail.templates';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../rbac/permissions.service';
import { toAdminUser, PUBLIC_USER_SELECT } from '../users/user.mapper';
import type {
  AdminQueryDto,
  CreateAdminDto,
  UpdateAdminDto,
} from './dto/admin.dto';

/**
 * Administration des comptes du back-office — SUPER_ADMIN uniquement.
 *
 * Trois règles non négociables (§8, §9 et §42 du contrat) :
 *  - un ADMIN ne peut pas être créé par une route publique ;
 *  - un ADMIN ne peut jamais administrer un SUPER_ADMIN ;
 *  - aucune route ne crée de SUPER_ADMIN. Ce compte est provisionné par
 *    le seed, avec des identifiants d'amorçage à changer immédiatement.
 *
 * Toute opération de ce service est auditée, sans exception.
 */
@Injectable()
export class AdminsService {
  private readonly logger = new Logger(AdminsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly scope: RestaurantScopeService,
  ) {}

  async list(query: AdminQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.UserWhereInput = {
      role: { in: [Role.ADMIN, Role.SUPER_ADMIN] },
      deletedAt: null,
    };

    if (query.role === 'ADMIN' || query.role === 'SUPER_ADMIN') {
      where.role = query.role as Role;
    }

    const status = parseEnum(AccountStatus, query.status);
    if (status) where.status = status;

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.user.count({ where }),
    ]);

    // Les permissions effectives sont résolues par compte : c'est ce que
    // l'écran « Administrateurs » affiche, et ce que le backend applique.
    const withPermissions = await Promise.all(
      rows.map(async (row) => toAdminUser(row, await this.permissions.getEffectivePermissions(row.id, row.role))),
    );

    return paginate(withPermissions, total, query.page, query.limit);
  }

  async findOne(id: string) {
    const admin = await this.prisma.user.findFirst({
      where: { id, role: { in: [Role.ADMIN, Role.SUPER_ADMIN] }, deletedAt: null },
      select: PUBLIC_USER_SELECT,
    });

    if (!admin) throw AppException.notFound('Administrateur introuvable.');

    return toAdminUser(admin, await this.permissions.getEffectivePermissions(admin.id, admin.role));
  }

  /**
   * Création d'un ADMIN.
   *
   * Les accès partent par e-mail — mot de passe provisoire ou lien
   * d'activation selon le mode. L'envoi est fait dans la transaction : si
   * l'e-mail ne part pas, aucun compte n'est créé, car un compte dont
   * personne n'a reçu les identifiants n'a aucune utilité.
   */
  async create(dto: CreateAdminDto, actor: AuthenticatedUser, context: RequestContext) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { email: true },
    });

    if (existing) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        existing.email === dto.email
          ? 'Cette adresse e-mail est déjà utilisée.'
          : 'Ce numéro de téléphone est déjà utilisé.',
      );
    }

    const mode = dto.credentialMode ?? 'temporary_password';
    const ttlHours = this.config.get<number>('security.activationTokenTtlHours') ?? 72;
    const activationToken = mode === 'activation_link' ? randomToken() : null;

    // Le mot de passe choisi par le SUPER_ADMIN passe par les mêmes règles de
    // robustesse que celui qu'un compte se donne lui-même.
    if (mode === 'temporary_password' && dto.password) {
      this.passwords.validate(dto.password);
    }

    // En mode lien d'activation, le condensat est celui d'un secret aléatoire
    // que personne ne connaît : le compte est inutilisable avant activation.
    const initialPassword =
      mode === 'temporary_password' ? (dto.password ?? randomPassword(12)) : randomPassword(24);
    const passwordHash = await this.passwords.hash(initialPassword);
    const backOfficeUrl = (this.config.get<string>('mail.backOfficeUrl') ?? '').replace(/\/$/, '');
    // Faux avec le pilote `noop` : rien n'a été expédié, et le back-office
    // doit alors afficher les accès au lieu d'annoncer un envoi.
    let emailSent = false;

    const created = await this.prisma.transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          restaurantId: this.scope.resolve(dto.restaurantId),
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          role: Role.ADMIN,
          status:
            mode === 'temporary_password' ? AccountStatus.ACTIVE : AccountStatus.PENDING,
          // Un mot de passe qui a transité par un tiers doit être remplacé
          // dès la première connexion.
          mustChangePassword: mode === 'temporary_password',
          createdById: actor.id,
        },
        select: PUBLIC_USER_SELECT,
      });

      if (activationToken) {
        await tx.authToken.create({
          data: {
            userId: user.id,
            purpose: AuthTokenPurpose.ACCOUNT_ACTIVATION,
            tokenHash: sha256(activationToken),
            expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
          },
        });
      }

      // L'envoi participe à la transaction : si l'e-mail ne part pas, le
      // compte n'est pas créé. Un compte dont personne n'a reçu les accès
      // serait inutilisable et devrait de toute façon être supprimé.
      emailSent = await this.mail.send(
        activationToken
          ? accountCreatedWithActivationLink({
              to: user.email,
              fullName: `${user.firstName} ${user.lastName}`.trim(),
              activationUrl: `${backOfficeUrl}/reset-password?mode=activation&token=${encodeURIComponent(activationToken)}`,
              expiresInHours: ttlHours,
              role: 'administrateur',
            })
          : accountCreatedWithPassword({
              to: user.email,
              fullName: `${user.firstName} ${user.lastName}`.trim(),
              password: initialPassword,
              loginUrl: `${backOfficeUrl}/login`,
              role: 'administrateur',
            }),
      );

      return user;
    });

    if (dto.permissions) {
      await this.permissions.setUserPermissions(created.id, Role.ADMIN, dto.permissions);
    }

    await this.audit.record({
      actor,
      action: 'ADMIN_CREATE',
      module: 'users',
      entityType: 'User',
      entityId: created.id,
      newValue: {
        email: created.email,
        role: Role.ADMIN,
        permissions: dto.permissions ?? 'socle du rôle',
        credentialMode: mode,
        // Le mot de passe lui-même n'entre jamais dans le journal d'audit.
        passwordChosenByCreator: mode === 'temporary_password' && Boolean(dto.password),
      },
      context,
    });

    this.logger.warn(`Compte ADMIN créé (${created.email}) par ${actor.email}.`);

    const admin = await this.findOne(created.id);

    // Les identifiants ne sont renvoyés qu'ici, à la création, et ne seront
    // plus jamais consultables : en cas de perte, il faut renvoyer un lien
    // d'activation.
    return {
      ...admin,
      // Le secret n'est renvoyé que si l'e-mail n'est pas parti : lorsqu'il
      // l'est, l'intéressé l'a déjà et le faire transiter une seconde fois
      // par le back-office ne ferait qu'élargir sa surface d'exposition.
      credentials:
        mode === 'temporary_password'
          ? {
              mode,
              emailSent,
              temporaryPassword: emailSent ? undefined : initialPassword,
              note: emailSent
                ? "Le mot de passe provisoire a été envoyé par e-mail. Il devra être changé à la première connexion."
                : "Envoi d'e-mails désactivé : communiquez ce mot de passe vous-même. Il devra être changé à la première connexion.",
            }
          : {
              mode,
              emailSent,
              activationToken: emailSent ? undefined : activationToken,
              expiresInHours: ttlHours,
              note: emailSent
                ? "Le lien d'activation a été envoyé par e-mail. Le compte reste inactif jusqu'à son utilisation."
                : "Envoi d'e-mails désactivé : transmettez ce lien vous-même. Le compte reste inactif jusqu'à son utilisation.",
            },
    };
  }

  async update(id: string, dto: UpdateAdminDto, actor: AuthenticatedUser, context: RequestContext) {
    const target = await this.assertManageable(id, actor);

    await this.prisma.user.update({ where: { id }, data: { ...dto } });

    await this.audit.record({
      actor,
      action: 'ADMIN_UPDATE',
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValue: {
        firstName: target.firstName,
        lastName: target.lastName,
        phone: target.phone,
      },
      newValue: dto,
      context,
    });

    return this.findOne(id);
  }

  /**
   * Suspension d'un administrateur.
   * Ses sessions sont fermées : un compte suspendu ne doit pas pouvoir
   * continuer à travailler avec un jeton encore valide.
   */
  async setStatus(
    id: string,
    status: string,
    actor: AuthenticatedUser,
    context: RequestContext,
    reason?: string,
  ) {
    const target = await this.assertManageable(id, actor);
    const next = (parseEnum(AccountStatus, status) ?? AccountStatus.ACTIVE) as AccountStatus;

    await this.prisma.user.update({ where: { id }, data: { status: next } });

    if (next !== AccountStatus.ACTIVE) {
      const closed = await this.tokens.revokeAllForUser(id);
      this.logger.warn(`${closed} session(s) fermée(s) pour l'administrateur ${target.email}.`);
    }

    await this.notifications.notify({
      userId: id,
      type: NotificationType.SECURITY,
      title: 'Statut de votre compte modifié',
      body:
        next === AccountStatus.SUSPENDED
          ? `Votre accès au back-office a été suspendu. ${reason ?? ''}`.trim()
          : `Votre compte est désormais ${next.toLowerCase()}.`,
      push: false,
    });

    await this.audit.record({
      actor,
      action: 'ADMIN_STATUS_UPDATE',
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValue: { status: target.status },
      newValue: { status: next, reason: reason ?? null },
      context,
    });

    return this.findOne(id);
  }

  /** Attribution fine des permissions d'un ADMIN. */
  async setPermissions(
    id: string,
    permissions: string[],
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const target = await this.assertManageable(id, actor);
    const before = await this.permissions.getEffectivePermissions(id, target.role);

    const after = await this.permissions.setUserPermissions(id, target.role, permissions);

    await this.notifications.notify({
      userId: id,
      type: NotificationType.SECURITY,
      title: 'Vos permissions ont été modifiées',
      body: 'Vos accès au back-office ont été mis à jour par un super administrateur.',
      push: false,
    });

    await this.audit.record({
      actor,
      action: 'ADMIN_PERMISSIONS_UPDATE',
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValue: { permissions: before },
      newValue: { permissions: after },
      context,
    });

    return this.findOne(id);
  }

  async resendActivation(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const target = await this.assertManageable(id, actor);

    if (target.status !== AccountStatus.PENDING) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Ce compte est déjà activé.');
    }

    const token = randomToken();
    const ttlHours = this.config.get<number>('security.activationTokenTtlHours') ?? 72;

    await this.prisma.transaction(async (tx) => {
      await tx.authToken.updateMany({
        where: { userId: id, purpose: AuthTokenPurpose.ACCOUNT_ACTIVATION, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.authToken.create({
        data: {
          userId: id,
          purpose: AuthTokenPurpose.ACCOUNT_ACTIVATION,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
        },
      });
    });

    await this.audit.record({
      actor,
      action: 'ADMIN_ACTIVATION_RESENT',
      module: 'users',
      entityType: 'User',
      entityId: id,
      context,
    });

    return { success: true, activationToken: token, expiresInHours: ttlHours };
  }

  /** Suppression logique : le journal d'audit conserve ses actions passées. */
  async remove(id: string, actor: AuthenticatedUser, context: RequestContext) {
    const target = await this.assertManageable(id, actor);

    // `email` et `phone` sont uniques en base. Les laisser tels quels sur une
    // ligne supprimée les rendrait définitivement inutilisables : on ne
    // pourrait plus jamais recréer un compte pour cette personne, et le
    // conflit renverrait vers un compte invisible dans l'interface. On les
    // libère donc en les préfixant — la valeur d'origine reste lisible pour
    // l'audit, et le journal ci-dessous la conserve intacte.
    const releaseTag = `supprime-${Date.now()}`;

    await this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: AccountStatus.INACTIVE,
        email: `${releaseTag}-${target.email}`,
        phone: `${releaseTag}-${target.phone}`,
      },
    });

    await this.tokens.revokeAllForUser(id);
    await this.permissions.invalidate(id);

    await this.audit.record({
      actor,
      action: 'ADMIN_DELETE',
      module: 'users',
      entityType: 'User',
      entityId: id,
      oldValue: { email: target.email, role: target.role },
      context,
    });

    return { success: true };
  }

  /**
   * Garde-fou commun à toutes les opérations d'administration.
   *
   * Elle interdit deux choses : toucher à un SUPER_ADMIN, et se modifier
   * soi-même (personne ne se retire ses propres accès par mégarde, et
   * personne ne s'auto-élève).
   */
  private async assertManageable(id: string, actor: AuthenticatedUser) {
    const target = await this.prisma.user.findFirst({
      where: { id, role: { in: [Role.ADMIN, Role.SUPER_ADMIN] }, deletedAt: null },
    });

    if (!target) throw AppException.notFound('Administrateur introuvable.');

    if (target.role === Role.SUPER_ADMIN) {
      throw AppException.forbidden(
        ERROR_CODES.CANNOT_MODIFY_SUPER_ADMIN,
        "Un compte SUPER_ADMIN ne peut pas être modifié depuis l'interface d'administration.",
      );
    }

    if (target.id === actor.id) {
      throw AppException.forbidden(
        ERROR_CODES.CANNOT_MODIFY_SELF,
        'Vous ne pouvez pas modifier votre propre compte par cette route.',
      );
    }

    return target;
  }
}
