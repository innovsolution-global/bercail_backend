import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service';

/**
 * Moteur de prix isolé dans son propre module : le panier et les
 * commandes l'utilisent tous les deux, sans dépendance circulaire.
 */
@Module({
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
