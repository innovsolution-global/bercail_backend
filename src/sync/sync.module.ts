import { Module } from '@nestjs/common';
import { SyncApplyService } from './sync-apply.service';
import { SyncNodeController, SyncStatusController } from './sync.controller';
import { SyncGuard } from './sync.guard';
import { SyncService } from './sync.service';

/**
 * Synchronisation entre le serveur du restaurant et celui en ligne.
 *
 * Le module se charge dans les deux nœuds, mais ils n'y jouent pas le même
 * rôle : le local engage les échanges, l'en-ligne se contente de répondre.
 * C'est `SYNC_NODE` qui décide.
 */
@Module({
  controllers: [SyncNodeController, SyncStatusController],
  providers: [SyncService, SyncApplyService, SyncGuard],
  exports: [SyncService],
})
export class SyncModule {}
