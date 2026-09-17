import { Role } from '@prisma/client';
import {
  CATALOG_WRITE_PERMISSIONS,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
} from '../common/constants/permissions.constant';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { PermissionsService } from './permissions.service';

/**
 * Qui peut modifier la carte commune.
 *
 * Depuis le 14 septembre 2026 la carte — plats, catégories, promotions —
 * est commune à toutes les maisons : un gérant qui change un prix le change
 * partout. Le propriétaire a donc décidé que ce droit ne serait plus acquis
 * d'office par un gérant, mais accordé par le super-admin à la création du
 * compte.
 *
 * Deux choses doivent tenir en même temps, et chacune peut casser seule :
 * le droit n'est **pas** dans le socle, et il reste **délégable**. Le
 * retirer du socle en le rangeant par erreur parmi les permissions
 * réservées le rendrait impossible à accorder — le super-admin cocherait la
 * case, et le serveur la refuserait.
 */
describe('Écriture de la carte commune', () => {
  it('n’est pas acquise d’office par un gérant', () => {
    for (const code of CATALOG_WRITE_PERMISSIONS) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(code);
    }
  });

  it('reste délégable par le super-admin', () => {
    for (const code of CATALOG_WRITE_PERMISSIONS) {
      expect(SUPER_ADMIN_ONLY_PERMISSIONS).not.toContain(code);
    }
  });

  it('laisse au gérant la lecture de la carte et la tenue de son stock', () => {
    // Consulter la carte et gérer la disponibilité restent du quotidien ;
    // la fiche technique, faite du stock de sa maison, dépend du stock.
    expect(ROLE_PERMISSIONS.ADMIN).toEqual(
      expect.arrayContaining(['MENU_READ', 'PROMOTIONS_READ', 'STOCK_MANAGE']),
    );
  });

  function monter() {
    const codes = [...ROLE_PERMISSIONS.SUPER_ADMIN];
    const idDe = (code: string) => `perm-${code}`;
    const tx = {
      userPermission: { deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async () => ({})) },
    };
    const prisma = {
      permission: { findMany: jest.fn(async () => codes.map((code) => ({ id: idDe(code), code }))) },
      transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const redis = { del: jest.fn(async () => undefined) };

    return {
      service: new PermissionsService(
        prisma as unknown as PrismaService,
        redis as unknown as RedisService,
      ),
      tx,
      idDe,
    };
  }

  it('s’accorde à la création du compte, par un ajout explicite', async () => {
    const { service, tx, idDe } = monter();

    await service.setUserPermissions('u1', Role.ADMIN, [
      ...ROLE_PERMISSIONS.ADMIN,
      'MENU_UPDATE',
      'PROMOTIONS_CREATE',
    ]);

    const [appel] = tx.userPermission.createMany.mock.calls[0] as unknown as [
      { data: { permissionId: string; granted: boolean; userId: string }[] },
    ];
    expect(appel.data).toEqual(
      expect.arrayContaining([
        { permissionId: idDe('MENU_UPDATE'), granted: true, userId: 'u1' },
        { permissionId: idDe('PROMOTIONS_CREATE'), granted: true, userId: 'u1' },
      ]),
    );
    // Rien du socle n'est retiré : seuls les deux ajouts sont enregistrés.
    expect(appel.data).toHaveLength(2);
  });

  it('ne donne rien de la carte à un gérant créé avec le socle seul', async () => {
    const { service, tx } = monter();

    await service.setUserPermissions('u1', Role.ADMIN, [...ROLE_PERMISSIONS.ADMIN]);

    // Aucun écart avec le socle : aucune ligne individuelle, donc aucun
    // droit sur la carte.
    expect(tx.userPermission.createMany).not.toHaveBeenCalled();
  });
});
