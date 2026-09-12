import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import {
  DeliveriesController,
  DriverDeliveriesController,
  OrderAssignmentController,
} from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DriverAssignmentService } from './driver-assignment.service';

@Module({
  imports: [OrdersModule],
  controllers: [
    DeliveriesController,
    OrderAssignmentController,
    DriverDeliveriesController,
  ],
  providers: [DeliveriesService, DriverAssignmentService,],
  exports: [DeliveriesService, DriverAssignmentService,],
})
export class DeliveriesModule {}
