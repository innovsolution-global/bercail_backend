import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AccountStatus, Role } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import { REALTIME_EVENTS, ROOMS } from './events.constant';

interface SocketUser {
  id: string;
  role: Role;
  driverProfileId?: string | null;
}

type AuthenticatedSocket = Socket & { data: { user?: SocketUser } };

/**
 * Passerelle temps réel.
 *
 * Le jeton est vérifié à la connexion, puis le socket rejoint uniquement
 * les salons que son rôle autorise :
 *  - tout le monde : son salon personnel (notifications) ;
 *  - ADMIN / SUPER_ADMIN : le salon d'exploitation (nouvelles commandes) ;
 *  - DRIVER : son salon de livreur (nouvelles courses).
 *
 * Un client ne choisit jamais son salon : il en demande un, le serveur
 * vérifie qu'il y a droit. Sans quoi n'importe qui écouterait les
 * commandes des autres.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(socket: AuthenticatedSocket): Promise<void> {
    try {
      const token = this.extractToken(socket);
      if (!token) throw new Error('Jeton absent');

      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
        issuer: this.config.get<string>('jwt.issuer'),
        audience: this.config.get<string>('jwt.audience'),
      });

      if (payload.type !== 'access') throw new Error('Type de jeton invalide');

      const user = await this.prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null },
        select: {
          id: true,
          role: true,
          status: true,
          driverProfile: { select: { id: true } },
        },
      });

      if (!user || user.status !== AccountStatus.ACTIVE) throw new Error('Compte inactif');

      socket.data.user = {
        id: user.id,
        role: user.role,
        driverProfileId: user.driverProfile?.id ?? null,
      };

      await socket.join(ROOMS.user(user.id));
      await socket.join(ROOMS.role(user.role));

      if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) {
        await socket.join(ROOMS.backOffice());
      }

      if (user.role === Role.DRIVER && user.driverProfile) {
        await socket.join(ROOMS.driver(user.driverProfile.id));
      }

      socket.emit('connected', { userId: user.id, role: user.role });
      this.logger.debug(`Socket connecté : ${user.id} (${user.role}).`);
    } catch (error) {
      this.logger.debug(`Connexion socket refusée : ${(error as Error).message}`);
      socket.emit('unauthorized', { message: 'Authentification requise.' });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: AuthenticatedSocket): void {
    const user = socket.data.user;
    if (user) this.logger.debug(`Socket déconnecté : ${user.id}.`);
  }

  /**
   * Suivi d'une commande.
   * Le serveur vérifie que le demandeur est bien le client de la commande,
   * le livreur assigné, ou un compte du back-office.
   */
  @SubscribeMessage('order:subscribe')
  async subscribeToOrder(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() body: { orderId?: string },
  ): Promise<{ success: boolean; message?: string }> {
    const user = socket.data.user;
    if (!user || !body?.orderId) return { success: false, message: 'Requête invalide.' };

    const order = await this.prisma.order.findUnique({
      where: { id: body.orderId },
      select: {
        id: true,
        customerId: true,
        delivery: { select: { driverId: true } },
      },
    });

    if (!order) return { success: false, message: 'Commande introuvable.' };

    const allowed =
      user.role === Role.ADMIN ||
      user.role === Role.SUPER_ADMIN ||
      order.customerId === user.id ||
      (user.role === Role.DRIVER && order.delivery?.driverId === user.driverProfileId);

    if (!allowed) return { success: false, message: 'Accès refusé.' };

    await socket.join(ROOMS.order(order.id));
    return { success: true };
  }

  @SubscribeMessage('order:unsubscribe')
  async unsubscribeFromOrder(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() body: { orderId?: string },
  ): Promise<{ success: boolean }> {
    if (body?.orderId) await socket.leave(ROOMS.order(body.orderId));
    return { success: true };
  }

  /** Sonde applicative : le client mobile vérifie que le lien est vivant. */
  @SubscribeMessage('ping')
  ping(): { event: string; at: string } {
    return { event: 'pong', at: new Date().toISOString() };
  }

  emitToRoom(room: string, event: string, payload: unknown): void {
    this.server?.to(room).emit(event, payload);
  }

  emitToRooms(rooms: string[], event: string, payload: unknown): void {
    if (rooms.length === 0) return;
    this.server?.to(rooms).emit(event, payload);
  }

  broadcastSystemAlert(payload: unknown): void {
    this.server?.to(ROOMS.role(Role.SUPER_ADMIN)).emit(REALTIME_EVENTS.SYSTEM_ALERT, payload);
  }

  private extractToken(socket: Socket): string | null {
    const auth = socket.handshake.auth as { token?: string } | undefined;
    if (auth?.token) return auth.token.replace(/^Bearer /i, '');

    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string') return header.replace(/^Bearer /i, '');

    const query = socket.handshake.query?.token;
    if (typeof query === 'string') return query;

    return null;
  }
}
