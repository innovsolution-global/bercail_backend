import { Injectable } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../database/prisma.service';
import { toMenuItemDto } from '../menu/menu.mapper';

/** Favoris d'un client. Strictement personnels. */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId, menuItem: { deletedAt: null } },
      include: {
        menuItem: {
          include: {
            category: { select: { id: true, name: true } },
            optionGroups: { include: { options: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return favorites.map((favorite) => ({
      ...toMenuItemDto(favorite.menuItem),
      favoritedAt: favorite.createdAt.toISOString(),
    }));
  }

  async add(userId: string, menuItemId: string) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null },
      select: { id: true },
    });
    if (!item) throw AppException.notFound('Plat introuvable.');

    // Idempotent : ajouter deux fois le même favori n'est pas une erreur.
    await this.prisma.favorite.upsert({
      where: { userId_menuItemId: { userId, menuItemId } },
      update: {},
      create: { userId, menuItemId },
    });

    return { success: true, menuItemId };
  }

  async remove(userId: string, menuItemId: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, menuItemId } });
    return { success: true, menuItemId };
  }

  async ids(userId: string): Promise<string[]> {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      select: { menuItemId: true },
    });
    return favorites.map((favorite) => favorite.menuItemId);
  }
}
