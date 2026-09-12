import { Module } from '@nestjs/common';
import { CartsModule } from '../carts/carts.module';
import { FinanceModule } from '../finance/finance.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ReviewsService } from './reviews.service';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { PricingModule } from './pricing.module';

@Module({
  imports: [PricingModule, CartsModule, FinanceModule],
  controllers: [OrdersController, PosController],
  providers: [OrdersService, PosService, ReviewsService],
  exports: [OrdersService, PosService],
})
export class OrdersModule {}
