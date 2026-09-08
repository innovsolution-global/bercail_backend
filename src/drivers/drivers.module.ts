import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { DriverProfileController, DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

@Module({
  imports: [AuthModule, DeliveriesModule],
  controllers: [DriversController, DriverProfileController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
