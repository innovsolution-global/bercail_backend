import { Global, Module } from '@nestjs/common';
import { RestaurantController, SettingsController } from './settings.controller';
import { RestaurantsController } from './restaurants.controller';
import { RestaurantsService } from './restaurants.service';
import { SettingsService } from './settings.service';

/**
 * Module global : les commandes, les paiements et les livraisons ont
 * tous besoin des réglages du restaurant.
 */
@Global()
@Module({
  controllers: [SettingsController, RestaurantController, RestaurantsController],
  providers: [SettingsService, RestaurantsService],
  exports: [SettingsService],
})
export class SettingsModule {}
