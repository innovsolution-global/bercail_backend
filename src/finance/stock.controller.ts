import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, Ctx, CurrentUser, RequirePermissions, Roles } from '../common/decorators';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import {
  CancelPurchaseDto,
  CreatePurchaseDto,
  PurchaseQueryDto,
  SettlePurchaseDto,
} from './dto/purchase.dto';
import {
  CreateStockItemDto,
  CreateStockMovementDto,
  StockItemQueryDto,
  StockMovementQueryDto,
  UpdateStockItemDto,
} from './dto/stock.dto';
import { CreateSupplierDto, SupplierQueryDto, UpdateSupplierDto } from './dto/supplier.dto';
import { PurchasesService } from './purchases.service';
import { StockService } from './stock.service';
import { SuppliersService } from './suppliers.service';

const BACK_OFFICE = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * Fournisseurs.
 */
@ApiTags('Fournisseurs')
@Controller('suppliers')
@Roles(...BACK_OFFICE)
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Lister les fournisseurs',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
    paginated: true,
  })
  list(@Query() query: SupplierQueryDto) {
    return this.suppliers.list(query);
  }

  @Get('options')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Fournisseurs actifs (sélecteur)',
    description: 'Liste courte, sans pagination, destinée aux formulaires d’achat.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  options() {
    return this.suppliers.options();
  }

  @Get(':id')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Détail d’un fournisseur',
    description: 'Inclut le montant total acheté et les 20 derniers approvisionnements.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.suppliers.findOne(id);
  }

  @Post()
  @RequirePermissions('SUPPLIERS_MANAGE')
  @ApiEndpoint({
    summary: 'Créer un fournisseur',
    roles: [...BACK_OFFICE],
    permissions: ['SUPPLIERS_MANAGE'],
  })
  create(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.suppliers.create(dto, user, context);
  }

  @Patch(':id')
  @RequirePermissions('SUPPLIERS_MANAGE')
  @ApiEndpoint({
    summary: 'Modifier un fournisseur',
    roles: [...BACK_OFFICE],
    permissions: ['SUPPLIERS_MANAGE'],
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.suppliers.update(id, dto, user, context);
  }

  @Delete(':id')
  @RequirePermissions('SUPPLIERS_MANAGE')
  @ApiEndpoint({
    summary: 'Supprimer un fournisseur (logique)',
    description: 'Les achats déjà enregistrés gardent leur fournisseur d’origine.',
    roles: [...BACK_OFFICE],
    permissions: ['SUPPLIERS_MANAGE'],
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.suppliers.remove(id, user, context);
  }
}

/**
 * Stock : articles et journal des mouvements.
 */
@ApiTags('Stock')
@Controller('stock')
@Roles(...BACK_OFFICE)
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('summary')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Synthèse du stock',
    description: 'Nombre d’articles, ruptures, alertes et valeur totale au coût moyen pondéré.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  summary() {
    return this.stock.summary();
  }

  @Get('alerts')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Articles à réapprovisionner',
    description: 'Articles dont la quantité est descendue au niveau du seuil d’alerte.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  alerts() {
    return this.stock.alerts();
  }

  @Get('movements')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Journal des mouvements de stock',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
    paginated: true,
  })
  movements(@Query() query: StockMovementQueryDto) {
    return this.stock.listMovements(query);
  }

  @Post('movements')
  @RequirePermissions('STOCK_MANAGE')
  @ApiEndpoint({
    summary: 'Enregistrer un mouvement de stock',
    description:
      'Entrée hors achat, sortie vers la cuisine, perte ou correction d’inventaire. Le stock et le coût moyen sont recalculés.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_MANAGE'],
  })
  createMovement(
    @Body() dto: CreateStockMovementDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.stock.createMovement(dto, user, context);
  }

  @Get('items')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Lister les articles de stock',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
    paginated: true,
  })
  listItems(@Query() query: StockItemQueryDto) {
    return this.stock.listItems(query);
  }

  @Get('items/:id')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Détail d’un article',
    description: 'Inclut les 30 derniers mouvements.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  findItem(@Param('id') id: string) {
    return this.stock.findItem(id);
  }

  @Post('items')
  @RequirePermissions('STOCK_MANAGE')
  @ApiEndpoint({
    summary: 'Créer un article de stock',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_MANAGE'],
  })
  createItem(
    @Body() dto: CreateStockItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.stock.createItem(dto, user, context);
  }

  @Patch('items/:id')
  @RequirePermissions('STOCK_MANAGE')
  @ApiEndpoint({
    summary: 'Modifier un article de stock',
    description: 'La quantité ne se modifie pas ici : elle ne bouge que par un mouvement.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_MANAGE'],
  })
  updateItem(
    @Param('id') id: string,
    @Body() dto: UpdateStockItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.stock.updateItem(id, dto, user, context);
  }

  @Delete('items/:id')
  @RequirePermissions('STOCK_MANAGE')
  @ApiEndpoint({
    summary: 'Supprimer un article (logique)',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_MANAGE'],
  })
  removeItem(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.stock.removeItem(id, user, context);
  }
}

/**
 * Approvisionnements.
 */
@ApiTags('Approvisionnements')
@Controller('purchases')
@Roles(...BACK_OFFICE)
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Lister les achats',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
    paginated: true,
  })
  list(@Query() query: PurchaseQueryDto) {
    return this.purchases.list(query);
  }

  @Get(':id')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Détail d’un achat',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  findOne(@Param('id') id: string) {
    return this.purchases.findOne(id);
  }

  @Get(':id/outcome')
  @RequirePermissions('STOCK_READ')
  @ApiEndpoint({
    summary: 'Ce qu’un achat a rapporté',
    description:
      'Suit chaque ligne dans le stock jusqu’à son épuisement : quantité consommée, restante, commandes servies avec cette marchandise, ventes et coût matière de ces commandes.',
    roles: [...BACK_OFFICE],
    permissions: ['STOCK_READ'],
  })
  outcome(@Param('id') id: string) {
    return this.purchases.outcome(id);
  }

  @Post()
  @RequirePermissions('PURCHASES_MANAGE')
  @ApiEndpoint({
    summary: 'Enregistrer un approvisionnement',
    description:
      'Entre la marchandise en stock, met à jour le coût moyen pondéré et crée la dépense correspondante — le tout dans une seule transaction.',
    roles: [...BACK_OFFICE],
    permissions: ['PURCHASES_MANAGE'],
  })
  create(
    @Body() dto: CreatePurchaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.purchases.create(dto, user, context);
  }

  @Patch(':id/settle')
  @RequirePermissions('PURCHASES_MANAGE')
  @ApiEndpoint({
    summary: 'Régler un achat à crédit',
    roles: [...BACK_OFFICE],
    permissions: ['PURCHASES_MANAGE'],
  })
  settle(
    @Param('id') id: string,
    @Body() dto: SettlePurchaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.purchases.settle(id, dto, user, context);
  }

  @Patch(':id/cancel')
  @RequirePermissions('PURCHASES_MANAGE')
  @ApiEndpoint({
    summary: 'Annuler un achat',
    description: 'Ressort la marchandise du stock et retire la dépense du journal.',
    roles: [...BACK_OFFICE],
    permissions: ['PURCHASES_MANAGE'],
  })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelPurchaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() context: RequestContext,
  ) {
    return this.purchases.cancel(id, dto, user, context);
  }
}
