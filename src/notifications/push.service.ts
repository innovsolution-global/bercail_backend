import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Notifications push — abstraction volontairement minimale.
 *
 * Le backend ne dépend pas d'un fournisseur : il expose « envoyer ce
 * message à cet utilisateur ». Le pilote par défaut se contente de
 * journaliser, ce qui permet de développer et de tester tout le parcours
 * sans compte Firebase. Brancher FCM consiste à implémenter `deliver`.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly driver: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.driver = this.config.get<string>('push.driver') ?? 'noop';
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
   * Point d'extension unique.
   *
   * Pour brancher Firebase : envoyer ici un lot vers l'API FCM v1 avec les
   * identifiants `push.fcm*`, puis supprimer de `device_tokens` les jetons
   * rejetés (`UNREGISTERED`), sinon la table se remplit d'appareils morts.
   */
  private async deliver(tokens: string[], message: PushMessage): Promise<void> {
    if (this.driver === 'noop') {
      this.logger.debug(
        `[push:noop] ${tokens.length} appareil(s) — ${message.title} : ${message.body}`,
      );
      return;
    }

    this.logger.warn(
      `Pilote push « ${this.driver} » non implémenté : message non envoyé (${message.title}).`,
    );
  }
}
