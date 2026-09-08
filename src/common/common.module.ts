import { Global, Module } from '@nestjs/common';
import { RestaurantScopeService } from './context/restaurant-scope.service';
import { IdempotencyService } from './services/idempotency.service';

/**
 * Services transverses disponibles partout sans import explicite.
 */
@Global()
@Module({
  providers: [IdempotencyService, RestaurantScopeService],
  exports: [IdempotencyService, RestaurantScopeService],
})
export class CommonModule {}
