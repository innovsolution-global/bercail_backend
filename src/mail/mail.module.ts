import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Module global : la création d'un administrateur comme celle d'un livreur
 * dépendent toutes deux de l'envoi des identifiants.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
