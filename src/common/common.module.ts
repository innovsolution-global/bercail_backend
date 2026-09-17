import { Global, Module } from '@nestjs/common';
import { DishAvailabilityService } from './context/dish-availability.service';
import { RestaurantRouter } from './context/restaurant-router.service';
import { RestaurantScopeService } from './context/restaurant-scope.service';
import { IdempotencyService } from './services/idempotency.service';

/**
 * Services transverses disponibles partout sans import explicite.
 */
@Global()
@Module({
  providers: [IdempotencyService, RestaurantRouter, RestaurantScopeService, DishAvailabilityService],
  exports: [IdempotencyService, RestaurantRouter, RestaurantScopeService, DishAvailabilityService],
})
export class CommonModule {}
