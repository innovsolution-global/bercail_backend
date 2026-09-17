import { SuppliersService } from './suppliers.service';

/**
 * Un fournisseur se crée avec les articles qu'il livre.
 *
 * Le propriétaire les écrivait dans « Spécialité », un simple texte, et
 * ne retrouvait rien à l'achat : la liste d'un approvisionnement ne
 * propose que des articles de stock. Ils entrent donc dans le stock, au
 * nom du fournisseur — sans jamais dupliquer un article déjà là.
 */
describe('Fournisseur et articles livrés', () => {
  const acteur = { id: 'u1', role: 'ADMIN' } as never;
  const contexte = {} as never;

  function monter(dejaEnStock: { id: string; name: string }[] = []) {
    const tx = {
      supplier: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f1', ...data })),
        update: jest.fn(async () => ({})),
        findUniqueOrThrow: jest.fn(async () => ({
          id: 'f1',
          name: 'MaiAgro',
          speciality: null,
          isActive: true,
          createdAt: new Date(),
          stockItems: [],
        })),
      },
      stockItem: {
        findFirst: jest.fn(async ({ where }: { where: { name: { equals: string } } }) =>
          dejaEnStock.find((item) => item.name.toLowerCase() === where.name.equals.toLowerCase()) ?? null,
        ),
        create: jest.fn(async () => ({})),
        update: jest.fn(async () => ({})),
      },
    };
    const prisma = {
      supplier: { findFirst: jest.fn(async () => null) },
      transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const scope = { resolve: jest.fn(() => 'kipe') };

    return { service: new SuppliersService(prisma as never, audit as never, scope as never), tx };
  }

  it('met chaque article livré dans le stock de la maison, au nom du fournisseur', async () => {
    const { service, tx } = monter();

    await service.create(
      {
        name: 'MaiAgro',
        items: [
          { name: ' Pomme ', category: 'fruit', unit: 'kg' },
          { name: 'Banane plantain', category: 'fruit', unit: 'kg' },
        ],
      } as never,
      acteur,
      contexte,
    );

    expect(tx.stockItem.create).toHaveBeenCalledTimes(2);
    expect(tx.stockItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: 'kipe',
        supplierId: 'f1',
        name: 'Pomme',
        category: 'FRUIT',
        unit: 'KG',
        quantity: 0,
      }),
    });
  });

  it('ne duplique pas un article déjà en réserve : il le rattache au fournisseur', async () => {
    const { service, tx } = monter([{ id: 's-pomme', name: 'pomme' }]);

    await service.create(
      { name: 'MaiAgro', items: [{ name: 'Pomme' }, { name: 'POMME' }] } as never,
      acteur,
      contexte,
    );

    expect(tx.stockItem.create).not.toHaveBeenCalled();
    // Une seule fois : le doublon de saisie est ignoré.
    expect(tx.stockItem.update).toHaveBeenCalledTimes(1);
    expect(tx.stockItem.update).toHaveBeenCalledWith({
      where: { id: 's-pomme' },
      data: { supplierId: 'f1' },
    });
  });

  it('ignore une ligne sans nom', async () => {
    const { service, tx } = monter();

    await service.create({ name: 'MaiAgro', items: [{ name: '   ' }] } as never, acteur, contexte);

    expect(tx.stockItem.create).not.toHaveBeenCalled();
    expect(tx.stockItem.update).not.toHaveBeenCalled();
  });
});
