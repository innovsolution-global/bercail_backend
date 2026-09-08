import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

export interface MailMessage {
  to: string;
  subject: string;
  /** Corps lisible partout, y compris sur les clients qui refusent le HTML. */
  text: string;
  html: string;
}

/**
 * Envoi d'e-mails — abstraction volontairement minimale, calquée sur
 * `PushService`.
 *
 * Le pilote par défaut (`noop`) journalise le message au lieu de l'expédier :
 * tout le parcours reste déroulable en développement sans compte SMTP. Le
 * pilote `smtp` s'appuie sur nodemailer et convient à Gmail comme à
 * n'importe quel relais.
 *
 * `send` **lève** en cas d'échec plutôt que d'avaler l'erreur : la création
 * d'un compte dépend de la remise effective de ses identifiants, et un
 * appelant qui ignorerait un échec laisserait un compte inutilisable.
 */
@Injectable()
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly driver: 'noop' | 'smtp';
  private readonly from: string;
  private transporter: Transporter | null = null;
  /** Pilote `smtp` demandé mais identifiants absents : tout envoi échoue. */
  private misconfigured = false;

  constructor(private readonly config: ConfigService) {
    this.driver = this.config.get<'noop' | 'smtp'>('mail.driver') ?? 'noop';
    this.from = this.config.get<string>('mail.from') ?? 'no-reply@lebercail.gn';

    if (this.driver === 'smtp') {
      const user = this.config.get<string>('mail.user') ?? '';
      const password = this.config.get<string>('mail.password') ?? '';

      if (!user || !password) {
        // Surtout pas de repli silencieux sur `noop` : la création d'un
        // compte est censée échouer si ses accès ne partent pas. Retomber
        // sur un pilote qui « réussit » toujours créerait des comptes dont
        // personne ne recevrait jamais le mot de passe.
        this.logger.error(
          'MAIL_DRIVER=smtp mais MAIL_USER ou MAIL_PASSWORD est vide : tout envoi échouera.',
        );
        this.misconfigured = true;
        return;
      }

      this.transporter = createTransport({
        host: this.config.get<string>('mail.host'),
        port: this.config.get<number>('mail.port'),
        secure: this.config.get<boolean>('mail.secure') === true,
        auth: { user, pass: password },
      });
    }
  }

  /**
   * Diagnostic au démarrage.
   *
   * Sans cela, une configuration incomplète ne se révèle qu'à la première
   * création de compte — c'est-à-dire à l'écran, devant l'utilisateur. On
   * préfère le dire tout de suite, dans le journal de démarrage.
   */
  async onModuleInit(): Promise<void> {
    if (this.misconfigured) {
      this.logger.error(
        "Envoi d'e-mails INDISPONIBLE : renseignez MAIL_PASSWORD (mot de passe " +
          "d'application Google) dans .env, puis redémarrez. Toute création de " +
          'compte sera refusée jusque-là.',
      );
      return;
    }

    if (this.driver === 'noop') {
      this.logger.warn(
        "Pilote e-mail « noop » : aucun message ne sera expédié, le contenu " +
          'est journalisé ici. Passez MAIL_DRIVER=smtp pour des envois réels.',
      );
      return;
    }

    // Une authentification refusée se voit ici, pas au premier compte créé.
    if (await this.verify()) {
      this.logger.log(`Relais SMTP prêt (${this.config.get<string>('mail.host')}).`);
    } else {
      this.logger.error(
        "Relais SMTP injoignable ou identifiants refusés : les créations de " +
          'compte échoueront. Vérifiez MAIL_USER et MAIL_PASSWORD.',
      );
    }
  }

  onModuleDestroy(): void {
    this.transporter?.close();
  }

  /**
   * Vérifie que le relais répond et accepte l'authentification.
   * Utile au démarrage ou avant une opération qui dépend de l'envoi.
   */
  async verify(): Promise<boolean> {
    if (this.misconfigured) return false;
    if (this.driver === 'noop' || !this.transporter) return true;
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      this.logger.error(`Relais SMTP injoignable : ${(error as Error).message}`);
      return false;
    }
  }

  /** `true` si le message est réellement parti, `false` en pilote `noop`. */
  async send(message: MailMessage): Promise<boolean> {
    if (this.misconfigured) {
      throw AppException.unprocessable(
        ERROR_CODES.VALIDATION_ERROR,
        "L'envoi d'e-mails n'est pas configuré (MAIL_PASSWORD est vide) : le compte n'a pas été créé.",
      );
    }

    if (this.driver === 'noop' || !this.transporter) {
      // Le corps figure dans le journal : en développement, c'est là qu'on
      // relève le mot de passe engendré.
      this.logger.warn(
        `[noop] E-mail non expédié à ${message.to} — « ${message.subject} »\n${message.text}`,
      );
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      this.logger.log(`E-mail « ${message.subject} » expédié à ${message.to}.`);
      return true;
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.error(`Échec d'envoi à ${message.to} : ${reason}`);
      throw AppException.unprocessable(
        ERROR_CODES.VALIDATION_ERROR,
        "L'e-mail n'a pas pu être envoyé : le compte n'a donc pas été créé. Vérifiez l'adresse, puis réessayez.",
        { errors: { email: "L'envoi de l'e-mail a échoué." } },
      );
    }
  }
}
