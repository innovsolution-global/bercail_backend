import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DevicePlatform, Role } from '@prisma/client';
import {
  AllowPasswordChangePending,
  ApiEndpoint,
  Ctx,
  CurrentUser,
  Public,
} from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { AuthService } from './auth.service';
import {
  ActivateAccountDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  RegisterDeviceDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateProfileDto,
} from './dto/auth.dto';

/**
 * Authentification — commune aux quatre rôles.
 *
 * Les routes sensibles sont plus sévèrement limitées que le reste de
 * l'API : une attaque par dictionnaire doit coûter cher.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @ApiEndpoint({
    summary: 'Inscription (CUSTOMER uniquement)',
    description:
      "L'inscription publique crée exclusivement un compte CUSTOMER. Les comptes DRIVER, ADMIN et SUPER_ADMIN ne peuvent pas être créés par cette route.",
    public: true,
  })
  register(@Body() dto: RegisterDto, @Ctx() context: RequestContext) {
    return this.auth.register(dto, context);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @ApiEndpoint({
    summary: 'Connexion',
    description:
      "Accepte l'e-mail ou le numéro de téléphone. Renvoie l'access token, le refresh token et le profil complet du compte (rôle et permissions inclus).",
    public: true,
  })
  login(@Body() dto: LoginDto, @Ctx() context: RequestContext) {
    return this.auth.login(dto, context);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 300_000 } })
  @ApiEndpoint({
    summary: 'Renouveler la session',
    description:
      'Rotation du refresh token : le jeton présenté est révoqué. Un jeton rejoué ferme toutes les sessions du compte.',
    public: true,
  })
  refresh(@Body() dto: RefreshTokenDto, @Ctx() context: RequestContext) {
    return this.auth.refresh(dto.refreshToken, context);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @AllowPasswordChangePending()
  @ApiEndpoint({ summary: 'Déconnexion' })
  logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LogoutDto,
    @Ctx() context: RequestContext,
  ) {
    return this.auth.logout(user, dto.refreshToken, context);
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @ApiEndpoint({
    summary: 'Mot de passe oublié',
    description:
      "Réponse identique que l'adresse existe ou non. Hors production, le jeton est renvoyé pour permettre de dérouler le scénario sans service d'e-mail.",
    public: true,
  })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Ctx() context: RequestContext) {
    return this.auth.forgotPassword(dto, context);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiEndpoint({
    summary: 'Réinitialiser le mot de passe',
    description: 'Consomme le jeton et ferme toutes les sessions ouvertes du compte.',
    public: true,
  })
  resetPassword(@Body() dto: ResetPasswordDto, @Ctx() context: RequestContext) {
    return this.auth.resetPassword(dto, context);
  }

  @Post('activate')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiEndpoint({
    summary: 'Activer un compte créé par le back-office',
    description:
      "Utilisé par un ADMIN (créé par le SUPER_ADMIN) ou un livreur : le compte passe de PENDING à ACTIVE et choisit son mot de passe.",
    public: true,
  })
  activate(@Body() dto: ActivateAccountDto, @Ctx() context: RequestContext) {
    return this.auth.activate(dto, context);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @AllowPasswordChangePending()
  @ApiEndpoint({
    summary: 'Changer son mot de passe',
    description:
      'Seule route ouverte à un compte devant encore changer son mot de passe temporaire (livreur ou admin à sa première connexion).',
  })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Ctx() context: RequestContext,
  ) {
    return this.auth.changePassword(user, dto, context);
  }

  @Get('me')
  @AllowPasswordChangePending()
  @ApiEndpoint({
    summary: 'Profil du compte connecté',
    description:
      'Renvoie le profil adapté au rôle : permissions pour un ADMIN, fiche livreur pour un DRIVER, fidélité pour un CUSTOMER.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  @Patch('me')
  @ApiEndpoint({
    summary: 'Modifier son propre profil',
    description:
      "Ouverte aux quatre rôles : chacun corrige son nom, son numéro ou son avatar sans passer par un administrateur. L'e-mail, le rôle, le statut et les permissions ne sont pas modifiables ici.",
    roles: [Role.CUSTOMER, Role.DRIVER, Role.ADMIN, Role.SUPER_ADMIN],
  })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @Ctx() context: RequestContext,
  ) {
    return this.auth.updateProfile(user, dto, context);
  }

  @Get('sessions')
  @ApiEndpoint({ summary: 'Sessions actives du compte' })
  sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.sessions(user.id);
  }

  @Delete('sessions/:id')
  @ApiEndpoint({ summary: 'Fermer une session à distance' })
  revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.auth.revokeSession(user.id, id);
  }

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Enregistrer un appareil pour les notifications push',
    description: 'Appelé par Flutter après obtention du jeton FCM.',
  })
  registerDevice(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    const platform = (dto.platform ?? 'android').toUpperCase() as DevicePlatform;
    return this.auth.registerDevice(user.id, dto.token, platform);
  }

  @Delete('devices/:token')
  @ApiEndpoint({ summary: 'Retirer un appareil' })
  removeDevice(@CurrentUser() user: AuthenticatedUser, @Param('token') token: string) {
    return this.auth.removeDevice(user.id, token);
  }
}
