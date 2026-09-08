import { Injectable } from '@nestjs/common';
import { Address } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { PrismaService } from '../database/prisma.service';
import type { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * Carnet d'adresses du client.
 *
 * Toutes les méthodes prennent `userId` en premier paramètre : il n'existe
 * aucun chemin de code capable de lire ou modifier l'adresse d'un autre
 * client. L'appartenance n'est pas une vérification ajoutée après coup,
 * elle est dans la signature.
 */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const addresses = await this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return addresses.map(this.toDto);
  }

  async findOne(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!address) throw AppException.notFound('Adresse introuvable.');
    return this.toDto(address);
  }

  async create(userId: string, dto: CreateAddressDto) {
    const count = await this.prisma.address.count({ where: { userId, deletedAt: null } });

    if (count >= 20) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Vous avez atteint le nombre maximal d’adresses enregistrées.',
      );
    }

    // La première adresse devient l'adresse par défaut, sans rien demander.
    const shouldBeDefault = dto.isDefault === true || count === 0;

    const address = await this.prisma.transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.address.create({
        data: {
          userId,
          label: dto.label ?? 'Domicile',
          street: dto.street,
          district: dto.district ?? '',
          city: dto.city ?? 'Conakry',
          latitude: dto.latitude,
          longitude: dto.longitude,
          phone: dto.phone,
          instructions: dto.instructions,
          isDefault: shouldBeDefault,
        },
      });
    });

    return this.toDto(address);
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    const existing = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Adresse introuvable.');

    const address = await this.prisma.transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      return tx.address.update({ where: { id }, data: { ...dto } });
    });

    return this.toDto(address);
  }

  async setDefault(userId: string, id: string) {
    const existing = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Adresse introuvable.');

    await this.prisma.transaction(async (tx) => {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      await tx.address.update({ where: { id }, data: { isDefault: true } });
    });

    return this.findOne(userId, id);
  }

  /**
   * Suppression logique : une commande passée référence cette adresse,
   * son historique doit rester lisible.
   */
  async remove(userId: string, id: string) {
    const existing = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Adresse introuvable.');

    await this.prisma.transaction(async (tx) => {
      await tx.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });

      if (existing.isDefault) {
        // On promeut la plus récente : le client ne se retrouve jamais
        // sans adresse par défaut.
        const next = await tx.address.findFirst({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });

    return { success: true };
  }

  /** Utilisé par la création de commande. */
  async getOwnedOrThrow(userId: string, id: string): Promise<Address> {
    const address = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!address) {
      throw AppException.badRequest(ERROR_CODES.ADDRESS_REQUIRED, 'Adresse de livraison invalide.');
    }
    return address;
  }

  toDto(address: Address) {
    return {
      id: address.id,
      label: address.label,
      street: address.street,
      district: address.district,
      city: address.city,
      latitude: address.latitude,
      longitude: address.longitude,
      phone: address.phone,
      instructions: address.instructions,
      isDefault: address.isDefault,
      createdAt: address.createdAt.toISOString(),
      updatedAt: address.updatedAt.toISOString(),
    };
  }
}
