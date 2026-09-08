import { StockMovementType } from '@prisma/client';
import { RecipesService } from './recipes.service';

/**
 * La déduction automatique repose sur deux règles qu'un lecteur pressé
 * inverserait volontiers : une commande ne se déduit qu'**une** fois, et un
 * ingrédient partagé par deux plats ne produit qu'**une** sortie de stock.
 *
 * Ces tests décrivent le comportement à partir d'une base simulée.
 */
describe('RecipesService — sortie de la matière', () => {
  const poulet = { id: 'stk-poulet', name: 'Poulet' };
  const huile = { id: 'stk-huile', name: 'Huile' };

  /** Deux plats qui partagent l'huile. */
  const recipes = [
    { menuItemId: 'plat-braise', stockItemId: poulet.id, quantity: 0.4, stockItem: poulet },
    { menuItemId: 'plat-braise', stockItemId: huile.id, quantity: 0.05, stockItem: huile },
    { menuItemId: 'plat-frites', stockItemId: huile.id, quantity: 0.2, stockItem: huile },
  ];

  function buildService(order: {
    stockConsumedAt: Date | null;
    items: { menuItemId: string | null; quantity: number }[];
  }) {
    const updates: Record<string, unknown>[] = [];

    const tx = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ id: 'ord-1', reference: 'BRC-1', ...order }),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return Promise.resolve({});
        }),
      },
      recipeIngredient: { findMany: jest.fn().mockResolvedValue(recipes) },
    };

    const prisma = { transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)) };
    const stock = { applyMovement: jest.fn().mockResolvedValue({}) };

    const service = new RecipesService(prisma as never, stock as never, {
      record: jest.fn(),
    } as never);

    return { service, stock, tx, updates };
  }

  it('additionne un ingrédient partagé en une seule sortie', async () => {
    const { service, stock } = buildService({
      stockConsumedAt: null,
      // Deux poulets braisés et une portion de frites.
      items: [
        { menuItemId: 'plat-braise', quantity: 2 },
        { menuItemId: 'plat-frites', quantity: 1 },
      ],
    });

    await service.consumeForOrder('ord-1', 'user-1');

    expect(stock.applyMovement).toHaveBeenCalledTimes(2);

    const byItem = new Map(
      stock.applyMovement.mock.calls.map(([, input]) => [input.stockItemId, input]),
    );

    // 0,4 × 2 = 0,8 kg de poulet.
    expect(byItem.get(poulet.id).quantity).toBe(0.8);
    // (0,05 × 2) + (0,2 × 1) = 0,3 L d'huile, en une ligne et non deux.
    expect(byItem.get(huile.id).quantity).toBe(0.3);
    expect(byItem.get(huile.id).type).toBe(StockMovementType.OUT);
  });

  it('laisse le stock passer sous zéro plutôt que de nier la vente', async () => {
    const { service, stock } = buildService({
      stockConsumedAt: null,
      items: [{ menuItemId: 'plat-braise', quantity: 1 }],
    });

    await service.consumeForOrder('ord-1', 'user-1');

    for (const [, input] of stock.applyMovement.mock.calls) {
      expect(input.allowNegative).toBe(true);
    }
  });

  it('ne déduit pas deux fois la même commande', async () => {
    const { service, stock } = buildService({
      stockConsumedAt: new Date(),
      items: [{ menuItemId: 'plat-braise', quantity: 1 }],
    });

    await service.consumeForOrder('ord-1', 'user-1');

    expect(stock.applyMovement).not.toHaveBeenCalled();
  });

  it('marque la commande avant d’écrire les mouvements', async () => {
    const { service, updates } = buildService({
      stockConsumedAt: null,
      items: [{ menuItemId: 'plat-braise', quantity: 1 }],
    });

    await service.consumeForOrder('ord-1', 'user-1');

    // En cas d'échec au milieu, mieux vaut une déduction incomplète qu'une
    // double déduction au prochain changement de statut.
    expect(updates[0].stockConsumedAt).toBeInstanceOf(Date);
  });

  it('ignore un plat sans fiche technique', async () => {
    const { service, stock } = buildService({
      stockConsumedAt: null,
      items: [{ menuItemId: 'plat-sans-fiche', quantity: 3 }],
    });

    await service.consumeForOrder('ord-1', 'user-1');

    expect(stock.applyMovement).not.toHaveBeenCalled();
  });

  it('n’interrompt jamais la commande si la déduction échoue', async () => {
    const { service, stock } = buildService({
      stockConsumedAt: null,
      items: [{ menuItemId: 'plat-braise', quantity: 1 }],
    });
    stock.applyMovement.mockRejectedValue(new Error('base indisponible'));

    // La cuisine ne s'arrête pas pour une écriture comptable.
    await expect(service.consumeForOrder('ord-1', 'user-1')).resolves.toBeUndefined();
  });
});
