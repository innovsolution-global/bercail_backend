import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import {
  DashboardController,
  ReportsController,
  SuperAdminDashboardController,
} from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [DashboardController, SuperAdminDashboardController, ReportsController],
  providers: [ReportsService, DashboardService],
  exports: [ReportsService, DashboardService],
})
export class ReportsModule {}
