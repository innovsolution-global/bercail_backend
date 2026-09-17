import { PurchasesService } from './purchases.service';

/**
 * Ce qu'un achat a rapporté.
 *
 * Demande du propriétaire, 16 sept. 2026 : « dans le menu stock on doit
 * voir les historiques d'achat pour avoir une idée de combien on a gagné
 * après épuisement du stock acheté ». La marchandise d'un achat sort du
 * stock commande après commande, dans l'ordre d'arrivée des lots ; on
 * retrouve ainsi les commandes servies avec ce lot, leurs ventes et leur
 * coût matière.
 */
describe('Devenir d’un achat', () => {
  const T = (minutes: number) => new Date(Date.UTC(2026, 8, 16, 8, minutes));

  type Mvt = {
    type: 'IN' | 'OUT' | 'ADJUSTMENT';
    quantity: number;
    quantityAfter: number;
    purchaseId?: string | null;
    orderId?: string | null;
    totalCost?: number;
    occurredAt: Date;
  };

  function monter(mouvements: Mvt[], ventes: Record<string, number> = {}) {
    const prisma = {
      purchase: {
        findFirst: jest.fn(async () => ({
          id: 'ach-2',
          reference: 'ACH-2',
          purchasedAt: T(10),
          totalAmount: 450_000,
          status: 'PAID',
          supplier: { name: 'MaiAgro' },
          items: [
            { id: 'l1', stockItemId: 'riz', name: 'Riz', unit: 'KG', quantity: 50, unitPrice: 9_000, lineTotal: 450_000 },
          ],
        })),
      },
      stockMovement: {
        findMany: jest.fn(async () =>
          mouvements.map((m) => ({ purchaseId: null, orderId: null, totalCost: 0, ...m })),
        ),
        aggregate: jest.fn(async ({ where }: { where: { orderId: { in: string[] } } }) => ({
          _sum: {
            totalCost: mouvements
              .filter((m) => m.orderId && where.orderId.in.includes(m.orderId))
              .reduce((sum, m) => sum + (m.totalCost ?? 0), 0),
          },
        })),
      },
      order: {
        aggregate: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({
          _sum: { subtotal: where.id.in.reduce((sum, id) => sum + (ventes[id] ?? 0), 0) },
        })),
      },
    };

    return new PurchasesService(prisma as never, {} as never, {} as never, {} as never);
  }

  it('sert d’abord le lot le plus ancien, puis suit celui de l’achat jusqu’à épuisement', async () => {
    // 20 kg en réserve d'un achat précédent, puis 50 kg de cet achat.
    // Les 25 premiers kilos sortis vident l'ancien lot et entament le
    // nôtre de 5 ; les 45 suivants le finissent.
    const service = monter(
      [
        { type: 'IN', quantity: 20, quantityAfter: 20, purchaseId: 'ach-1', occurredAt: T(0) },
        { type: 'IN', quantity: 50, quantityAfter: 70, purchaseId: 'ach-2', occurredAt: T(10) },
        { type: 'OUT', quantity: 25, quantityAfter: 45, orderId: 'c1', totalCost: 225_000, occurredAt: T(20) },
        { type: 'OUT', quantity: 45, quantityAfter: 0, orderId: 'c2', totalCost: 405_000, occurredAt: T(30) },
        { type: 'OUT', quantity: 3, quantityAfter: -3, orderId: 'c3', totalCost: 27_000, occurredAt: T(40) },
      ],
      { c1: 300_000, c2: 700_000, c3: 90_000 },
    );

    const bilan = await service.outcome('ach-2');
    const [riz] = bilan.lines;

    expect(riz.consumed).toBe(50);
    expect(riz.remaining).toBe(0);
    expect(riz.exhaustedAt).toBe(T(30).toISOString());
    // c3 est sortie après épuisement : elle n'a rien pris à ce lot.
    expect(riz.ordersCount).toBe(2);
    expect(bilan.ordersCount).toBe(2);
    expect(bilan.sales).toBe(1_000_000);
    expect(bilan.materialCost).toBe(630_000);
    expect(bilan.grossMargin).toBe(370_000);
    expect(bilan.exhausted).toBe(true);
  });

  it('dit ce qui reste d’un lot encore en réserve', async () => {
    const service = monter(
      [
        { type: 'IN', quantity: 50, quantityAfter: 50, purchaseId: 'ach-2', occurredAt: T(10) },
        { type: 'OUT', quantity: 12.5, quantityAfter: 37.5, orderId: 'c1', totalCost: 112_500, occurredAt: T(20) },
      ],
      { c1: 200_000 },
    );

    const bilan = await service.outcome('ach-2');

    expect(bilan.lines[0]).toMatchObject({ consumed: 12.5, remaining: 37.5, exhaustedAt: null });
    expect(bilan.exhausted).toBe(false);
    expect(bilan.grossMargin).toBe(87_500);
  });

  it('ne compte pas une sortie manuelle comme une vente', async () => {
    // Une perte sort du lot, mais n'a rien rapporté.
    const service = monter([
      { type: 'IN', quantity: 50, quantityAfter: 50, purchaseId: 'ach-2', occurredAt: T(10) },
      { type: 'OUT', quantity: 5, quantityAfter: 45, occurredAt: T(20) },
    ]);

    const bilan = await service.outcome('ach-2');

    expect(bilan.lines[0]).toMatchObject({ consumed: 5, remaining: 45, ordersCount: 0, sales: 0 });
  });
});
