import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ApiEndpoint, CurrentUser, Roles } from '../common/decorators';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AddressesService } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * Adresses du client connecté.
 *
 * Aucune route n'accepte d'identifiant d'utilisateur : le client ne peut
 * désigner que ses propres adresses, l'identité vient du jeton.
 */
@ApiTags('Customers')
@Controller('addresses')
@Roles(Role.CUSTOMER, Role.ADMIN, Role.SUPER_ADMIN)
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ApiEndpoint({ summary: 'Mes adresses', roles: [Role.CUSTOMER] })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.addresses.list(user.id);
  }

  @Post()
  @ApiEndpoint({
    summary: 'Ajouter une adresse',
    description: 'La première adresse enregistrée devient automatiquement l’adresse par défaut.',
    roles: [Role.CUSTOMER],
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAddressDto) {
    return this.addresses.create(user.id, dto);
  }

  @Get(':id')
  @ApiEndpoint({ summary: 'Détail d’une adresse', roles: [Role.CUSTOMER] })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.addresses.findOne(user.id, id);
  }

  @Patch(':id')
  @ApiEndpoint({ summary: 'Modifier une adresse', roles: [Role.CUSTOMER] })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addresses.update(user.id, id, dto);
  }

  @Patch(':id/default')
  @ApiEndpoint({ summary: 'Définir l’adresse par défaut', roles: [Role.CUSTOMER] })
  setDefault(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.addresses.setDefault(user.id, id);
  }

  @Delete(':id')
  @ApiEndpoint({
    summary: 'Supprimer une adresse',
    description: 'Suppression logique : les commandes déjà livrées gardent leur adresse.',
    roles: [Role.CUSTOMER],
  })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.addresses.remove(user.id, id);
  }
}
