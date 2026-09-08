import { Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiEndpoint, CurrentUser } from '../common/decorators';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { NotificationsService } from './notifications.service';

export class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Ne renvoyer que les notifications non lues.' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  unreadOnly?: boolean;
}

/**
 * Notifications du compte connecté.
 *
 * Les quatre rôles utilisent les mêmes routes : le contenu diffère, le
 * contrat non. Chaque compte ne voit que ses propres notifications.
 */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiEndpoint({ summary: 'Mes notifications', paginated: true })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: NotificationQueryDto) {
    return this.notifications.list(user.id, {
      page: query.page,
      limit: query.limit,
      unreadOnly: query.unreadOnly,
    });
  }

  @Get('unread-count')
  @ApiEndpoint({
    summary: 'Nombre de notifications non lues',
    description: 'Appel léger, conçu pour le badge de la barre de navigation.',
  })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Patch('read-all')
  @ApiEndpoint({ summary: 'Tout marquer comme lu' })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Patch(':id/read')
  @ApiEndpoint({ summary: 'Marquer une notification comme lue' })
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Delete(':id')
  @ApiEndpoint({ summary: 'Supprimer une notification' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.remove(user.id, id);
  }
}
