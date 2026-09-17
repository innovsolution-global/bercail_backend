import { Role } from '@prisma/client';
import { RestaurantsService } from './restaurants.service';

/**
 * Ouvrir, et fermer, une adresse depuis le back-office.
 *
 * Le propriétaire ouvre ses établissements depuis la page « Établissements ».
 * Deux choses doivent suivre sans délai : les zones desservies, que le
 * formulaire « Nouveau livreur » propose, et le routage de proximité, qui
 * garde sa liste de maisons en mémoire une minute.
 */
describe('Établissements', () => {
  const proprietaire = { id: 'sa', role: Role.SUPER_ADMIN } as never;
  const contexte = {} as never;

  function monter() {
    const prisma = {
      restaurant: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'r-new',
          isActive: true,
          currency: 'GNF',
          createdAt: new Date(),
          ...data,
        })),
        findFirst: jest.fn(async () => ({ id: 'r-new', code: 'BRC3', name: 'Lambanyi', isActive: true })),
        count: jest.fn(async () => 3),
        update: jest.fn(async () => ({})),
      },
    };
    const audit = { record: jest.fn(async () => undefined) };
    const router = { forget: jest.fn() };

    return {
      service: new RestaurantsService(prisma as never, audit as never, router as never),
      prisma,
      router,
    };
  }

  const ouverture = {
    code: ' brc3 ',
    name: ' Le Bercail — Lambanyi ',
    phone: '+224620000003',
    email: 'lambanyi@lebercail.gn',
    address: 'Lambanyi, route du Niger',
    city: 'Conakry',
    latitude: 9.66,
    longitude: -13.6,
    deliveryZones: [' Lambanyi', 'Sonfonia', 'Lambanyi', ''],
  };

  it('enregistre ses zones desservies, sans blanc ni doublon', async () => {
    const { service, prisma } = monter();

    const cree = await service.create(ouverture as never, proprietaire, contexte);

    expect(prisma.restaurant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: 'BRC3',
        name: 'Le Bercail — Lambanyi',
        deliveryZones: ['Lambanyi', 'Sonfonia'],
      }),
    });
    expect(cree.deliveryZones).toEqual(['Lambanyi', 'Sonfonia']);
  });

  it('met la nouvelle maison en service sans attendre le mémo du routage', async () => {
    const { service, router } = monter();

    await service.create(ouverture as never, proprietaire, contexte);

    expect(router.forget).toHaveBeenCalled();
  });

  it('retire aussitôt du routage une maison fermée', async () => {
    const { service, router } = monter();

    await service.close('r-new', proprietaire, contexte);

    expect(router.forget).toHaveBeenCalled();
  });

  it('laisse l’ouverture au seul propriétaire', async () => {
    const { service, prisma } = monter();

    await expect(
      service.create(ouverture as never, { id: 'g', role: Role.ADMIN } as never, contexte),
    ).rejects.toThrow(/Seul le propriétaire/);
    expect(prisma.restaurant.create).not.toHaveBeenCalled();
  });
});
