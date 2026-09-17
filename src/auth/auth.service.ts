import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  AuthTokenPurpose,
  AuditResult,
  DevicePlatform,
  Role,
  User,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { randomNumericCode, randomToken, sha256 } from '../common/utils/crypto.util';
import { PrismaService } from '../database/prisma.service';
import { MailService } from '../mail/mail.service';
import { passwordResetCode } from '../mail/mail.templates';
import { RealtimeService } from '../realtime/realtime.service';
import { PermissionsService } from '../rbac/permissions.service';
import { toAuthUser, type AuthUserDto } from '../users/user.mapper';
import type {
  ActivateAccountDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { PasswordService } from './password.service';
import { TokenService, type TokenPair } from './token.service';

export interface AuthSession extends TokenPair {
  user: AuthUserDto;
}

/**
 * Authentification des quatre rôles.
 *
 * Un seul point d'entrée : `/auth/login` sert le client Flutter, le
 * livreur Flutter et le back-office React. Ce qui change d'un rôle à
 * l'autre, ce n'est pas la route, c'est ce que le compte a le droit de
 * faire ensuite.
 *
 * Règles structurantes :
 *  - l'inscription publique ne crée QUE des CUSTOMER ;
 *  - un DRIVER est créé par un ADMIN, un ADMIN par le SUPER_ADMIN ;
 *  - aucun message ne révèle si un e-mail existe.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly mail: MailService,
  ) {}

  private get isProduction(): boolean {
    return this.config.get<boolean>('isProduction') === true;
  }

  // ───────────────────────────── Inscription ──────────────────────────────

  /**
   * Inscription publique — réservée aux CUSTOMER.
   *
   * Le rôle n'est pas un champ du DTO : même si le client en envoie un,
   * il n'atteint jamais la base. C'est la règle §5 du contrat.
   */
  async register(dto: RegisterDto, context: RequestContext): Promise<AuthSession> {
    this.passwords.validate(dto.password);

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { id: true, email: true, phone: true },
    });

    if (existing) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        existing.email === dto.email
          ? 'Cette adresse e-mail est déjà utilisée.'
          : 'Ce numéro de téléphone est déjà utilisé.',
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    const user = await this.prisma.transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          role: Role.CUSTOMER,
          status: AccountStatus.ACTIVE,
          customerProfile: { create: {} },
          cart: { create: {} },
        },
        include: { customerProfile: true, driverProfile: true },
      });
      return created;
    });

    await this.audit.record({
      actor: { id: user.id, firstName: user.firstName, lastName: user.lastName, role: user.role },
      action: 'AUTH_REGISTER',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      context,
    });

    const tokens = await this.tokens.issuePair(user, context);
    await this.markLogin(user.id);

    return { ...tokens, user: toAuthUser(user, []) };
  }

  // ─────────────────────────────── Connexion ──────────────────────────────

  async login(dto: LoginDto, context: RequestContext): Promise<AuthSession> {
    const identifier = dto.email.trim();

    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: identifier.toLowerCase() }, { phone: identifier }],
      },
      include: { driverProfile: true, customerProfile: true },
    });

    if (!user) {
      // Temps de réponse identique à un mot de passe erroné : impossible
      // de savoir si l'adresse existe.
      await this.passwords.wasteTime();
      await this.audit.record({
        actorName: identifier,
        action: 'AUTH_LOGIN',
        module: 'auth',
        result: AuditResult.FAILURE,
        metadata: { reason: 'UNKNOWN_IDENTIFIER' },
        context,
      });
      throw AppException.unauthorized(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Identifiants incorrects.',
      );
    }

    this.assertNotLocked(user);

    const valid = await this.passwords.compare(dto.password, user.passwordHash);
    if (!valid) {
      await this.registerFailedAttempt(user, context);
      throw AppException.unauthorized(ERROR_CODES.INVALID_CREDENTIALS, 'Identifiants incorrects.');
    }

    this.assertLoginAllowed(user);

    const tokens = await this.tokens.issuePair(user, context);
    await this.markLogin(user.id);

    if (dto.deviceToken) {
      await this.registerDevice(user.id, dto.deviceToken, DevicePlatform.ANDROID);
    }

    await this.audit.record({
      actor: { id: user.id, firstName: user.firstName, lastName: user.lastName, role: user.role },
      action: 'AUTH_LOGIN',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      context,
    });

    const permissions = await this.permissions.getEffectivePermissions(user.id, user.role);
    return { ...tokens, user: toAuthUser(user, permissions) };
  }

  /** Un compte doit être ACTIF pour ouvrir une session. */
  private assertLoginAllowed(user: User): void {
    switch (user.status) {
      case AccountStatus.SUSPENDED:
        throw AppException.forbidden(
          ERROR_CODES.ACCOUNT_SUSPENDED,
          'Votre compte est suspendu. Contactez le restaurant.',
        );
      case AccountStatus.INACTIVE:
        throw AppException.forbidden(ERROR_CODES.ACCOUNT_INACTIVE, 'Votre compte est désactivé.');
      case AccountStatus.PENDING:
        throw AppException.forbidden(
          ERROR_CODES.ACCOUNT_PENDING,
          "Votre compte n'est pas encore activé. Utilisez le lien d'activation reçu.",
        );
      default:
        break;
    }
  }

  private assertNotLocked(user: User): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw AppException.forbidden(
        ERROR_CODES.ACCOUNT_LOCKED,
        `Trop de tentatives. Réessayez dans ${minutes} minute(s).`,
      );
    }
  }

  /**
   * Verrouillage progressif.
   * Le compteur est en base (et non en cache) : redémarrer le serveur ne
   * doit pas offrir de nouvelles tentatives à un attaquant.
   */
  private async registerFailedAttempt(user: User, context: RequestContext): Promise<void> {
    const max = this.config.get<number>('security.maxLoginAttempts') ?? 5;
    const lockoutMinutes = this.config.get<number>('security.lockoutMinutes') ?? 15;
    const attempts = user.failedLoginAttempts + 1;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: attempts >= max ? new Date(Date.now() + lockoutMinutes * 60_000) : null,
      },
    });

    await this.audit.record({
      actor: { id: user.id, firstName: user.firstName, lastName: user.lastName, role: user.role },
      action: 'AUTH_LOGIN',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      result: AuditResult.FAILURE,
      metadata: { attempts, locked: attempts >= max },
      context,
    });

    if (attempts >= max) {
      await this.prisma.securityAlert.create({
        data: {
          severity: 'MEDIUM',
          title: 'Compte verrouillé après échecs répétés',
          description: `${attempts} tentatives de connexion ont échoué sur le compte ${user.email}.`,
          metadata: { userId: user.id, ipAddress: context.ipAddress ?? null },
        },
      });
    }
  }

  private async markLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  // ─────────────────────────────── Session ────────────────────────────────

  async refresh(refreshToken: string, context: RequestContext): Promise<AuthSession> {
    const { user, tokens } = await this.tokens.rotate(refreshToken, context);

    if (user.deletedAt) {
      throw AppException.unauthorized(ERROR_CODES.UNAUTHORIZED, 'Compte introuvable.');
    }
    this.assertLoginAllowed(user);

    const full = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { driverProfile: true, customerProfile: true },
    });

    const permissions = await this.permissions.getEffectivePermissions(user.id, user.role);
    return { ...tokens, user: toAuthUser(full, permissions) };
  }

  async logout(user: AuthenticatedUser, refreshToken: string | undefined, context: RequestContext) {
    if (refreshToken) {
      await this.tokens.revokeByToken(refreshToken);
    } else {
      // Sans refresh token, on ferme toutes les sessions : c'est le
      // comportement le plus sûr pour un appareil partagé.
      await this.tokens.revokeAllForUser(user.id);
    }

    /*
     * Un livreur qui se déconnecte n'est plus en service.
     *
     * Sa présence est celle de son application : en ligne tant qu'il y est
     * connecté, hors ligne dès qu'il la quitte. Sans cette ligne, il
     * restait « en ligne » une demi-heure après avoir fermé sa session, et
     * le back-office pouvait lui confier une course qu'il ne verrait pas.
     */
    if (user.role === Role.DRIVER && user.driverProfileId) {
      const profile = await this.prisma.driverProfile.update({
        where: { id: user.driverProfileId },
        data: { isOnline: false, isAvailable: false, lastSeenAt: new Date() },
      });
      this.realtime.driverStatusUpdated({
        driverProfileId: profile.id,
        restaurantId: user.restaurantId ?? null,
        isOnline: false,
        isAvailable: false,
      });
    }

    await this.audit.record({
      actor: user,
      action: 'AUTH_LOGOUT',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      context,
    });

    return { success: true };
  }

  async me(userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { driverProfile: true, customerProfile: true },
    });

    if (!user) throw AppException.notFound('Compte introuvable.');

    const permissions = await this.permissions.getEffectivePermissions(user.id, user.role);
    return toAuthUser(user, permissions);
  }

  /**
   * Modification de son propre profil — les quatre rôles.
   *
   * Un gestionnaire doit pouvoir corriger son nom ou son numéro sans
   * dépendre d'un SUPER_ADMIN. Ce qui reste hors de portée, en revanche :
   * l'e-mail (identifiant de connexion), le rôle, le statut et les
   * permissions. Un compte ne s'auto-promeut pas.
   */
  async updateProfile(
    user: AuthenticatedUser,
    dto: UpdateProfileDto,
    context: RequestContext,
  ): Promise<AuthUserDto> {
    const current = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
    });
    if (!current) throw AppException.notFound('Compte introuvable.');

    if (dto.phone && dto.phone !== current.phone) {
      const conflict = await this.prisma.user.findFirst({
        where: { phone: dto.phone, NOT: { id: user.id } },
        select: { id: true },
      });
      if (conflict) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'Ce numéro de téléphone est déjà utilisé.',
        );
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        // Chaîne vide = retrait de la photo. On stocke `null` plutôt qu'une
        // chaîne vide, sans quoi la base porterait deux façons de dire
        // « pas d'avatar ».
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl || null } : {}),
      },
    });

    // Un changement de coordonnées sur un compte du back-office mérite
    // une trace : c'est par là que passent les alertes de sécurité.
    await this.audit.record({
      actor: user,
      action: 'PROFILE_UPDATE',
      module: 'users',
      entityType: 'User',
      entityId: user.id,
      oldValue: {
        firstName: current.firstName,
        lastName: current.lastName,
        phone: current.phone,
      },
      newValue: {
        firstName: dto.firstName ?? current.firstName,
        lastName: dto.lastName ?? current.lastName,
        phone: dto.phone ?? current.phone,
      },
      context,
    });

    return this.me(user.id);
  }

  async sessions(userId: string) {
    const sessions = await this.tokens.listSessions(userId);
    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    await this.tokens.revokeSession(userId, sessionId);
    return { success: true };
  }

  // ────────────────────────────── Mot de passe ────────────────────────────

  /**
   * Demande de réinitialisation.
   *
   * La réponse est toujours identique, que l'adresse existe ou non :
   * l'endpoint ne doit pas devenir un annuaire de comptes.
   */
  async forgotPassword(dto: ForgotPasswordDto, context: RequestContext) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    const response: { sent: true; resetToken?: string; resetCode?: string } = { sent: true };

    if (!user) return response;

    const ttlMinutes = this.config.get<number>('security.resetTokenTtlMinutes') ?? 30;

    /*
     * Deux clés pour la même demande, envoyées dans le même e-mail :
     *
     *  • un **code à six chiffres**, que le client tape dans l'application
     *    mobile — on ne recopie pas un lien de soixante caractères sur un
     *    téléphone ;
     *  • un **jeton long**, porté par le lien que le back-office ouvre.
     *
     * Le code est court, donc devinable : il n'est valable que pour ce
     * compte (son empreinte mêle l'identifiant du compte), il expire, il ne
     * sert qu'une fois, et la route est plafonnée à cinq essais par quart
     * d'heure. Aucun e-mail ne partait avant : le jeton n'était que
     * journalisé, et « Envoyer le code » n'envoyait rien.
     */
    const token = randomToken();
    const code = randomNumericCode(6);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    await this.prisma.transaction(async (tx) => {
      // Une seule demande valable à la fois.
      await tx.authToken.updateMany({
        where: { userId: user.id, purpose: AuthTokenPurpose.PASSWORD_RESET, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.authToken.createMany({
        data: [
          {
            userId: user.id,
            purpose: AuthTokenPurpose.PASSWORD_RESET,
            tokenHash: sha256(token),
            expiresAt,
          },
          {
            userId: user.id,
            purpose: AuthTokenPurpose.PASSWORD_RESET,
            tokenHash: sha256(this.codeKey(user.id, code)),
            expiresAt,
          },
        ],
      });
    });

    const backOfficeUrl = (this.config.get<string>('mail.backOfficeUrl') ?? '').replace(/\/$/, '');
    const sent = await this.mail.send(
      passwordResetCode({
        to: user.email,
        firstName: user.firstName,
        code,
        resetUrl: `${backOfficeUrl}/reset-password?token=${encodeURIComponent(token)}`,
        expiresInMinutes: ttlMinutes,
      }),
    );
    if (!sent) {
      this.logger.error(`E-mail de réinitialisation non expédié à ${user.email}.`);
    }

    await this.audit.record({
      actor: { id: user.id, firstName: user.firstName, lastName: user.lastName, role: user.role },
      action: 'AUTH_FORGOT_PASSWORD',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      context,
    });

    if (!this.isProduction) {
      // Hors production, le code et le jeton sont renvoyés pour dérouler
      // le scénario sans boîte mail. Jamais en production.
      this.logger.warn(`Réinitialisation (dev) pour ${user.email} : code ${code}, jeton ${token}`);
      response.resetToken = token;
      response.resetCode = code;
    }

    return response;
  }

  /** L'empreinte d'un code court mêle le compte : le même code chez deux personnes ne se confond pas. */
  private codeKey(userId: string, code: string): string {
    return `${userId}:${code.replace(/\s+/g, '')}`;
  }

  async resetPassword(dto: ResetPasswordDto, context: RequestContext) {
    this.passwords.validate(dto.password);

    /*
     * Le jeton du lien se cherche tel quel ; le code à six chiffres se
     * cherche pour le compte de l'adresse donnée. Sans compte à cette
     * adresse, on cherche quand même le jeton long — et on répond la même
     * chose qu'à un code faux : rien ne dit si l'adresse existe.
     */
    const owner = dto.email
      ? await this.prisma.user.findFirst({
          where: { email: dto.email, deletedAt: null },
          select: { id: true },
        })
      : null;
    const hashes = [sha256(dto.token)];
    if (owner) hashes.push(sha256(this.codeKey(owner.id, dto.token)));

    const stored = await this.prisma.authToken.findFirst({
      where: { tokenHash: { in: hashes } },
      include: { user: true },
    });

    if (
      !stored ||
      stored.purpose !== AuthTokenPurpose.PASSWORD_RESET ||
      stored.usedAt ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      throw AppException.badRequest(
        ERROR_CODES.INVALID_TOKEN,
        'Ce code est invalide ou expiré. Demandez-en un nouveau.',
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id: stored.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      // Le code et le lien de la même demande tombent ensemble.
      await tx.authToken.updateMany({
        where: { userId: stored.userId, purpose: AuthTokenPurpose.PASSWORD_RESET, usedAt: null },
        data: { usedAt: new Date() },
      });
    });

    // Un mot de passe changé ferme toutes les sessions ouvertes.
    await this.tokens.revokeAllForUser(stored.userId);

    await this.audit.record({
      actor: {
        id: stored.user.id,
        firstName: stored.user.firstName,
        lastName: stored.user.lastName,
        role: stored.user.role,
      },
      action: 'AUTH_RESET_PASSWORD',
      module: 'auth',
      entityType: 'User',
      entityId: stored.userId,
      context,
    });

    return { success: true };
  }

  async changePassword(user: AuthenticatedUser, dto: ChangePasswordDto, context: RequestContext) {
    const stored = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    const valid = await this.passwords.compare(dto.currentPassword, stored.passwordHash);
    if (!valid) {
      throw AppException.badRequest(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Le mot de passe actuel est incorrect.',
      );
    }

    if (dto.currentPassword === dto.newPassword) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Le nouveau mot de passe doit être différent de l’ancien.',
      );
    }

    this.passwords.validate(dto.newPassword);
    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });

    await this.tokens.revokeAllForUser(user.id);

    await this.audit.record({
      actor: user,
      action: 'AUTH_CHANGE_PASSWORD',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      context,
    });

    return { success: true };
  }

  /**
   * Activation d'un compte créé par le back-office (ADMIN ou DRIVER).
   * Le compte passe de PENDING à ACTIVE et choisit son mot de passe.
   */
  async activate(dto: ActivateAccountDto, context: RequestContext): Promise<AuthSession> {
    this.passwords.validate(dto.password);

    const stored = await this.prisma.authToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
      include: { user: { include: { driverProfile: true, customerProfile: true } } },
    });

    if (
      !stored ||
      stored.purpose !== AuthTokenPurpose.ACCOUNT_ACTIVATION ||
      stored.usedAt ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      throw AppException.badRequest(
        ERROR_CODES.INVALID_TOKEN,
        "Ce lien d'activation est invalide ou expiré.",
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    const user = await this.prisma.transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: stored.userId },
        data: {
          passwordHash,
          status: AccountStatus.ACTIVE,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
        include: { driverProfile: true, customerProfile: true },
      });
      await tx.authToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } });
      return updated;
    });

    await this.audit.record({
      actor: { id: user.id, firstName: user.firstName, lastName: user.lastName, role: user.role },
      action: 'AUTH_ACTIVATE_ACCOUNT',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      context,
    });

    const tokens = await this.tokens.issuePair(user, context);
    const permissions = await this.permissions.getEffectivePermissions(user.id, user.role);

    return { ...tokens, user: toAuthUser(user, permissions) };
  }

  // ──────────────────────────── Notifications push ────────────────────────

  async registerDevice(userId: string, token: string, platform: DevicePlatform) {
    await this.prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform },
      create: { userId, token, platform },
    });
    return { success: true };
  }

  async removeDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { success: true };
  }
}
