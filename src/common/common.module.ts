import { Global, Module } from '@nestjs/common';
import { RestaurantRouter } from './context/restaurant-router.service';
import { RestaurantScopeService } from './context/restaurant-scope.service';
import { IdempotencyService } from './services/idempotency.service';

/**
 * Services transverses disponibles partout sans import explicite.
 */
@Global()
@Module({
  providers: [IdempotencyService, RestaurantRouter, RestaurantScopeService],
  exports: [IdempotencyService, RestaurantRouter, RestaurantScopeService],
})
export class CommonModule {}
