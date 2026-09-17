import { Module } from '@nestjs/common';
import { KitchenSelector } from './kitchen-selector.service';
import { PricingService } from './pricing.service';

/**
 * Moteur de prix isolé dans son propre module : le panier et les
 * commandes l'utilisent tous les deux, sans dépendance circulaire.
 *
 * Le choix de la cuisine vit avec lui, pour la même raison : le panier
 * doit être chiffré chez la maison qui préparera, et c'est la commande
 * qui la retient.
 */
@Module({
  providers: [PricingService, KitchenSelector],
  exports: [PricingService, KitchenSelector],
})
export class PricingModule {}
