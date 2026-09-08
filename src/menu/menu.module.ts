import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController, MenuItemsController } from './menu.controller';
import { MenuItemsService } from './menu-items.service';

@Module({
  controllers: [CategoriesController, MenuItemsController],
  providers: [CategoriesService, MenuItemsService],
  exports: [CategoriesService, MenuItemsService],
})
export class MenuModule {}
