import { StockMovementReason, StockMovementType, StockUnit } from '@prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { StockService } from './stock.service';

/**
 * Le coût moyen pondéré est le chiffre qui valorise la réserve et les
 * sorties de cuisine : c'est lui qui répond à « combien vaut ce qu'il y a
 * dans le frigo ? » et « combien m'a coûté ce que j'ai cuisiné ? ».
 *
 * Ces tests décrivent son comportement à partir d'un article simulé, sans
 * base de données : la règle doit tenir toute seule.
 */
describe('StockService — mouvements', () => {
  const poulet = {
    id: 'stk-poulet',
    name: 'Poulet entier',
    unit: StockUnit.KG,
    quantity: 10,
    averageCost: 40_000,
    deletedAt: null,
  };

  /**
   * Transaction simulée : on retient ce qui a été écrit pour pouvoir
   * l'inspecter, exactement comme le ferait Prisma.
   */
  function buildTx(item = { ...poulet }) {
    const updates: Record<string, unknown>[] = [];

    const tx = {
      stockItem: {
        findFirst: jest.fn().mockResolvedValue(item),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return Promise.resolve({ ...item, ...data });
        }),
      },
      stockMovement: {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => data),
      },
    };

    // Le périmètre d'établissement ne joue aucun rôle dans le calcul du
    // coût moyen : un double inerte suffit.
    const service = new StockService({} as never, {} as never, {
      resolve: () => 'restaurant-test',
      current: () => 'restaurant-test',
    } as never);

    return { service, tx, updates };
  }

  it('recalcule le coût moyen pondéré à chaque entrée', async () => {
    const { service, tx, updates } = buildTx();

    // 10 kg à 40 000 + 30 kg à 48 000 = 40 kg à 46 000.
    const movement = await service.applyMovement(tx as never, {
      stockItemId: poulet.id,
      type: StockMovementType.IN,
      reason: StockMovementReason.PURCHASE,
      quantity: 30,
      unitCost: 48_000,
    });

    expect(movement.quantityAfter).toBe(40);
    expect(updates[0].quantity).toBe(40);
    expect(updates[0].averageCost).toBe(46_000);
    expect(movement.totalCost).toBe(30 * 48_000);
  });

  it('valorise une sortie au coût moyen, sans le modifier', async () => {
    const { service, tx, updates } = buildTx();

    const movement = await service.applyMovement(tx as never, {
      stockItemId: poulet.id,
      type: StockMovementType.OUT,
      reason: StockMovementReason.PREPARATION,
      quantity: 4,
    });

    expect(movement.quantityAfter).toBe(6);
    expect(movement.unitCost).toBe(40_000);
    expect(movement.totalCost).toBe(160_000);
    // Une sortie consomme au prix déjà connu : elle ne change pas la moyenne.
    expect(updates[0].averageCost).toBe(40_000);
  });

  it('refuse une sortie supérieure au stock disponible', async () => {
    const { service, tx } = buildTx();

    await expect(
      service.applyMovement(tx as never, {
        stockItemId: poulet.id,
        type: StockMovementType.OUT,
        reason: StockMovementReason.PREPARATION,
        quantity: 25,
      }),
    ).rejects.toBeInstanceOf(AppException);

    expect(tx.stockItem.update).not.toHaveBeenCalled();
  });

  it('aligne le stock sur la quantité comptée lors d’un inventaire', async () => {
    const { service, tx, updates } = buildTx();

    // On a compté 7,5 kg alors que le système en annonçait 10.
    const movement = await service.applyMovement(tx as never, {
      stockItemId: poulet.id,
      type: StockMovementType.ADJUSTMENT,
      reason: StockMovementReason.INVENTORY,
      quantity: 7.5,
    });

    expect(updates[0].quantity).toBe(7.5);
    expect(movement.quantityAfter).toBe(7.5);
    // Le mouvement porte l'écart constaté, pas le stock final.
    expect(movement.quantity).toBe(2.5);
  });

  it('garde les quantités décimales au gramme près', async () => {
    const { service, tx } = buildTx({ ...poulet, quantity: 0.1, averageCost: 0 });

    const movement = await service.applyMovement(tx as never, {
      stockItemId: poulet.id,
      type: StockMovementType.IN,
      reason: StockMovementReason.PURCHASE,
      quantity: 0.2,
      unitCost: 1000,
    });

    // 0,1 + 0,2 vaut 0,3 — et non 0,30000000000000004.
    expect(movement.quantityAfter).toBe(0.3);
  });
});
