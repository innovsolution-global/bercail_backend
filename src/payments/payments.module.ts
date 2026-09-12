import { Module } from '@nestjs/common';
import { ChapChapWebhookController } from './chapchap.controller';
import { ChapChapService } from './chapchap.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController, ChapChapWebhookController],
  providers: [PaymentsService, ChapChapService],
  exports: [PaymentsService, ChapChapService],
})
export class PaymentsModule {}
