import { Injectable, Logger } from '@nestjs/common';
import { Notification, NotificationType, Prisma, Role } from '@prisma/client';
import { paginate, type PaginatedResult } from '../common/dto/paginated-result';
import { AppException } from '../common/exceptions/app.exception';
import { toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from './push.service';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  entityId?: string;
  data?: Record<string, string>;
  /** Envoyer aussi une notification push (par défaut : oui). */
  push?: boolean;
}

/**
 * Notifications applicatives.
 *
 * Trois canaux pour un même événement : la ligne en base (historique),
 * le temps réel (badge instantané) et le push (application fermée).
 * Les services métier n'en connaissent qu'un seul point d'entrée.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
  ) {}

  async notify(input: NotifyInput): Promise<Notification | null> {
    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link,
          entityId: input.entityId,
          data: input.data as Prisma.InputJsonValue | undefined,
        },
      });

      this.realtime.notificationCreated(input.userId, this.toDto(notification));

      if (input.push !== false) {
        await this.push.sendToUser(input.userId, {
          title: input.title,
          body: input.body,
          data: { ...(input.data ?? {}), type: input.type, entityId: input.entityId ?? '' },
        });
      }

      return notification;
    } catch (error) {
      // Une notification perdue ne doit jamais annuler une commande.
      this.logger.error(`Notification non envoyée : ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Diffusion au back-office.
   * Chaque ADMIN et SUPER_ADMIN actif reçoit sa propre ligne : le badge
   * « non lu » est personnel, il ne se partage pas.
   */
  async notifyBackOffice(input: Omit<NotifyInput, 'userId'>): Promise<void> {
    const staff = await this.prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.SUPER_ADMIN] }, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });

    if (staff.length === 0) return;

    await this.prisma.notification.createMany({
      data: staff.map((member) => ({
        userId: member.id,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
        entityId: input.entityId,
        data: input.data as Prisma.InputJsonValue | undefined,
      })),
    });

    const payload = {
      type: toWire(input.type),
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      entityId: input.entityId ?? null,
      createdAt: new Date().toISOString(),
    };

    this.realtime.notifyRole(Role.ADMIN, 'notification.created', payload);
    this.realtime.notifyRole(Role.SUPER_ADMIN, 'notification.created', payload);

    if (input.push !== false) {
      await this.push.sendToUsers(
        staff.map((member) => member.id),
        { title: input.title, body: input.body },
      );
    }
  }

  async list(
    userId: string,
    query: { page: number; limit: number; unreadOnly?: boolean },
  ): Promise<PaginatedResult<ReturnType<NotificationsService['toDto']>>> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unreadOnly ? { isRead: false } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toDto(row)), total, query.page, query.limit);
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({ where: { userId, isRead: false } });
    return { count };
  }

  async markRead(userId: string, id: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() },
    });
    if (updated.count === 0) throw AppException.notFound('Notification introuvable.');
    return { success: true };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { success: true, updated: result.count };
  }

  async remove(userId: string, id: string) {
    const deleted = await this.prisma.notification.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) throw AppException.notFound('Notification introuvable.');
    return { success: true };
  }

  toDto(notification: Notification) {
    return {
      id: notification.id,
      type: toWire(notification.type),
      title: notification.title,
      body: notification.body,
      isRead: notification.isRead,
      link: notification.link,
      entityId: notification.entityId,
      createdAt: notification.createdAt.toISOString(),
    };
  }
}
