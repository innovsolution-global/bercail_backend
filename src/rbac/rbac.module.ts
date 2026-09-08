import { Global, Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

/**
 * RBAC.
 *
 * Module global : les guards et la stratégie JWT ont besoin du service de
 * permissions partout, sans l'importer dans chaque module métier.
 */
@Global()
@Module({
  controllers: [PermissionsController],
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class RbacModule {}
