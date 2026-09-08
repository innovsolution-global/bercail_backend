import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { CustomerProfileController, CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [CustomersController, CustomerProfileController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
