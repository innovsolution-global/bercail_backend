import { existsSync, readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type Messaging, type MulticastMessage } from 'firebase-admin/messaging';
import { PrismaService } from '../database/prisma.service';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** Le canal Android sur lequel l'application range ses alertes (voir `push_notifications.dart`). */
const ANDROID_CHANNEL = 'bercail_alerts';

/** FCM plafonne un envoi groupé à 500 appareils. */
const LOT = 500;

/** Les codes FCM qui disent qu'un jeton est mort : on le retire, sinon la table se remplit d'appareils fantômes. */
const JETON_MORT = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Notifications push.
 *
 * Le reste du serveur ne connaît que « envoyer ce message à cet
 * utilisateur » : c'est ici que Firebase Cloud Messaging est branché. Sans
 * identifiants — `PUSH_DRIVER=noop`, ou `fcm` sans clé —, le pilote
 * journalise et ne casse rien : le parcours se développe et se teste sans
 * compte Firebase, et une clé absente en production se voit dans le
 * journal au démarrage plutôt qu'à la première commande manquée.
 *
 * ## Les identifiants
 *
 * Un compte de service Firebase (console → Paramètres du projet → Comptes
 * de service → « Générer une nouvelle clé privée »). Soit le fichier JSON
 * tel quel, désigné par `FIREBASE_SERVICE_ACCOUNT_FILE` ; soit ses trois
 * champs recopiés dans `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`,
 * `FCM_PRIVATE_KEY`. Le fichier ne se versionne pas : il donne les pleins
 * pouvoirs sur le projet Firebase.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly driver: string;
  private messaging: Messaging | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.driver = this.config.get<string>('push.driver') ?? 'noop';
    if (this.driver === 'fcm') this.messaging = this.connect();
  }

  /** `true` quand les envois partent réellement chez Firebase. */
  get enabled(): boolean {
    return this.messaging !== null;
  }

  async sendToUser(userId: string, message: PushMessage): Promise<void> {
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true, platform: true },
    });

    if (devices.length === 0) return;
    await this.deliver(
      devices.map((device) => device.token),
      message,
    );
  }

  async sendToUsers(userIds: string[], message: PushMessage): Promise<void> {
    if (userIds.length === 0) return;
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });
    if (devices.length === 0) return;
    await this.deliver(
      devices.map((device) => device.token),
      message,
    );
  }

  /**
   * Ouvre la connexion à Firebase, ou explique pourquoi elle ne s'ouvre pas.
   *
   * Une clé manquante ne fait pas tomber le serveur : le push est un
   * confort, pas une condition pour commander. Mais elle se dit au
   * démarrage, en avertissement, pour ne pas être découverte à la
   * première alerte qui n'arrive jamais.
   */
  private connect(): Messaging | null {
    try {
      const credential = this.credential();
      if (!credential) {
        this.logger.warn(
          'PUSH_DRIVER=fcm sans identifiants : renseignez FIREBASE_SERVICE_ACCOUNT_FILE (fichier JSON du compte de service) ou FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY. Les notifications push ne partiront pas.',
        );
        return null;
      }

      const app: App =
        getApps().find((existing) => existing.name === 'bercail-push') ??
        initializeApp({ credential: cert(credential) }, 'bercail-push');
      this.logger.log(`Notifications push : Firebase branché (projet ${credential.projectId}).`);
      return getMessaging(app);
    } catch (error) {
      this.logger.error(`Notifications push : Firebase refuse les identifiants — ${String(error)}`);
      return null;
    }
  }

  private credential(): { projectId: string; clientEmail: string; privateKey: string } | null {
    const file = this.config.get<string>('push.serviceAccountFile');
    if (file) {
      if (!existsSync(file)) {
        this.logger.warn(`FIREBASE_SERVICE_ACCOUNT_FILE introuvable : ${file}`);
      } else {
        const json = JSON.parse(readFileSync(file, 'utf8')) as {
          project_id?: string;
          client_email?: string;
          private_key?: string;
        };
        if (json.project_id && json.client_email && json.private_key) {
          return {
            projectId: json.project_id,
            clientEmail: json.client_email,
            privateKey: json.private_key,
          };
        }
        this.logger.warn(`FIREBASE_SERVICE_ACCOUNT_FILE incomplet : ${file}`);
      }
    }

    const projectId = this.config.get<string>('push.fcmProjectId') ?? '';
    const clientEmail = this.config.get<string>('push.fcmClientEmail') ?? '';
    const privateKey = this.config.get<string>('push.fcmPrivateKey') ?? '';
    if (projectId && clientEmail && privateKey) return { projectId, clientEmail, privateKey };
    return null;
  }

  /**
   * Envoie à un lot d'appareils, et retire ceux que Firebase déclare morts.
   *
   * Un jeton meurt quand l'application est désinstallée ou réinstallée :
   * sans ce ménage, chaque alerte partirait vers des appareils qui
   * n'existent plus, et la table grossirait sans fin.
   */
  private async deliver(tokens: string[], message: PushMessage): Promise<void> {
    if (!this.messaging) {
      this.logger.debug(
        `[push:${this.driver}] ${tokens.length} appareil(s) — ${message.title} : ${message.body}`,
      );
      return;
    }

    const morts: string[] = [];

    for (let i = 0; i < tokens.length; i += LOT) {
      const lot = tokens.slice(i, i + LOT);
      const payload: MulticastMessage = {
        tokens: lot,
        notification: { title: message.title, body: message.body },
        data: message.data ?? {},
        android: {
          priority: 'high',
          notification: { channelId: ANDROID_CHANNEL, sound: 'default' },
        },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      };

      try {
        const result = await this.messaging.sendEachForMulticast(payload);
        result.responses.forEach((response, index) => {
          if (response.success) return;
          const code = response.error?.code ?? '';
          if (JETON_MORT.has(code)) {
            morts.push(lot[index]);
          } else {
            this.logger.warn(`Push refusé (${code}) : ${response.error?.message ?? ''}`);
          }
        });
      } catch (error) {
        // Un push perdu ne doit jamais faire échouer ce qui l'a déclenché.
        this.logger.error(`Envoi push impossible : ${String(error)}`);
      }
    }

    if (morts.length > 0) {
      await this.prisma.deviceToken.deleteMany({ where: { token: { in: morts } } });
      this.logger.log(`${morts.length} appareil(s) retiré(s) : jeton(s) expiré(s).`);
    }
  }
}
