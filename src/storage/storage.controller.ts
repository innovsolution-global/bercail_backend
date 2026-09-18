import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, CurrentUser, RequireAnyPermission, Roles } from '../common/decorators';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { StorageService, type UploadedFileLike } from './storage.service';

/**
 * Téléversement de fichiers.
 *
 * Un seul point d'entrée pour les avatars, les photos de plats, le logo
 * du restaurant et les visuels de promotion. Le serveur renomme le
 * fichier, vérifie son type et sa taille, puis renvoie l'URL à stocker
 * dans la ressource concernée.
 */
@ApiTags('Settings')
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('avatar')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiEndpoint({
    summary: 'Téléverser un avatar',
    description: 'Accessible à tous les rôles, pour leur propre photo de profil.',
  })
  async avatar(
    @UploadedFile() file: UploadedFileLike,
    @CurrentUser() _user: AuthenticatedUser,
  ) {
    return this.storage.store(file, 'avatars');
  }

  @Post('menu')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  // Une photo de plat ou de catégorie ne sert qu'à qui peut écrire la carte
  // commune : sans ce contrôle, la route annonçait une permission qu'elle
  // ne vérifiait pas.
  @RequireAnyPermission('MENU_CREATE', 'MENU_UPDATE', 'CATEGORIES_MANAGE')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiEndpoint({
    summary: 'Téléverser une photo de plat',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['MENU_CREATE', 'MENU_UPDATE', 'CATEGORIES_MANAGE'],
  })
  async menu(@UploadedFile() file: UploadedFileLike) {
    return this.storage.store(file, 'menu');
  }

  @Post('restaurant')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiEndpoint({
    summary: 'Téléverser le logo ou la couverture du restaurant',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['SETTINGS_UPDATE'],
  })
  async restaurant(@UploadedFile() file: UploadedFileLike) {
    return this.storage.store(file, 'restaurant');
  }

  @Post('promotion')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @RequireAnyPermission('PROMOTIONS_CREATE', 'PROMOTIONS_UPDATE')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiEndpoint({
    summary: 'Téléverser un visuel de promotion',
    roles: [Role.ADMIN, Role.SUPER_ADMIN],
    permissions: ['PROMOTIONS_CREATE', 'PROMOTIONS_UPDATE'],
  })
  async promotion(@UploadedFile() file: UploadedFileLike) {
    return this.storage.store(file, 'promotions');
  }
}
