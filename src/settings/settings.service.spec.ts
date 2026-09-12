import type { AuditService } from '../audit/audit.service';
import { restaurantContext } from '../common/context/restaurant-context';
import { RestaurantRouter } from '../common/context/restaurant-router.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { SettingsService } from './settings.service';

/**
 * Quels réglages lit-on, et surtout : lesquels modifie-t-on.
 *
 * `getRestaurant()` sert deux écrans très différents — la fiche publique
 * de l'application mobile, et l'écran « Réglages » du back-office. Or
 * elle rendait dans tous les cas le restaurant **le plus ancien** : un
 * ADMIN de la seconde adresse y changeait donc les horaires, les frais de
 * livraison et le minimum de commande de la première, sans qu'aucun
 * écran ne le laisse deviner.
 *
 * Le vrai `RestaurantScopeService` est monté ici plutôt qu'un double : la
 * règle testée est justement la sienne, et un double se contenterait de
 * répéter ce qu'on croit qu'elle fait.
 */
describe('Réglages du restaurant', () => {
  const ANCIEN = 'restaurant-kaloum';
  const SECOND = 'restaurant-kipe';

  function monter() {
    const lues: string[] = [];
    const clesEcrites: string[] = [];

    const prisma = {
      restaurant: {
        findFirst: jest.fn(async () => ({ id: ANCIEN })),
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          lues.push(args.where.id);
          return {
            id: args.where.id,
            openingHours: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }),
      },
    };

    const redis = {
      get: jest.fn(async () => null),
      set: jest.fn(async (cle: string) => {
        clesEcrites.push(cle);
      }),
      del: jest.fn(),
      delByPattern: jest.fn(),
    };

    const service = new SettingsService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      { record: jest.fn() } as unknown as AuditService,
      { get: () => 600 } as never,
      new RestaurantScopeService(
        prisma as unknown as PrismaService,
        new RestaurantRouter(prisma as unknown as PrismaService),
      ),
    );

    return { service, lues, clesEcrites };
  }

  it('sert au compte les réglages de sa maison, pas de la plus ancienne', async () => {
    const { service, lues } = monter();

    await restaurantContext.run({ restaurantId: SECOND, unrestricted: false }, () =>
      service.getRestaurant(),
    );

    expect(lues).toEqual([SECOND]);
  });

  it('sert la plus ancienne au client, qui n’est rattaché à aucune maison', async () => {
    // C'est le repli, et il reste juste : l'application mobile ne
    // propose pas de choisir son établissement, elle en montre un.
    const { service, lues } = monter();

    await restaurantContext.run({ restaurantId: null, unrestricted: true }, () =>
      service.getRestaurant(),
    );

    expect(lues).toEqual([ANCIEN]);
  });

  it('ne partage pas la fiche en cache entre deux maisons', async () => {
    // Une clé unique servirait les frais de livraison et le minimum de
    // commande de la première maison lue à toutes les autres — sur le
    // chemin critique des commandes, donc sur de l'argent.
    const { service, clesEcrites } = monter();

    await restaurantContext.run({ restaurantId: SECOND, unrestricted: false }, () =>
      service.getRestaurantCached(),
    );
    await restaurantContext.run({ restaurantId: null, unrestricted: true }, () =>
      service.getRestaurantCached(),
    );

    expect(clesEcrites).toHaveLength(2);
    expect(clesEcrites[0]).not.toBe(clesEcrites[1]);
  });
});

/**
 * Les adresses posées sur le plan de l'application.
 *
 * L'onglet « Localisation » n'affichait qu'un repère — celui de
 * l'établissement dont il sert la carte. Les autres adresses de
 * l'enseigne existaient en base et n'apparaissaient nulle part côté
 * client. Ce que cette liste doit garantir :
 *
 *  • **toutes** les adresses ouvertes, pas seulement la plus ancienne ;
 *  • un état d'ouverture calculé **par adresse** — deux maisons de la
 *    même enseigne n'ouvrent pas forcément aux mêmes heures ;
 *  • aucune adresse fermée définitivement ni supprimée ;
 *  • rien qui laisse croire qu'on peut commander dans chacune : ni frais
 *    de livraison, ni minimum de commande, ni moyens de paiement.
 */
describe('Les adresses de l’enseigne', () => {
  const KALOUM = 'restaurant-kaloum';
  const KIPE = 'restaurant-kipe';

  function maison(id: string, nom: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: nom,
      tagline: '',
      logoUrl: null,
      coverImageUrl: null,
      phone: '620000000',
      address: 'Conakry',
      district: '',
      city: 'Conakry',
      latitude: 9.5,
      longitude: -13.7,
      isOpen: true,
      deliveryEnabled: true,
      pickupEnabled: true,
      deliveryFee: 15000,
      minimumOrderAmount: 50000,
      openingHours: [],
      isActive: true,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    };
  }

  function monter(maisons: ReturnType<typeof maison>[]) {
    let filtre: unknown;
    let fiche: Record<string, unknown> | undefined;

    const prisma = {
      restaurant: {
        // `findFirst` sert deux appels très différents : la résolution de
        // la maison servie (sans `where`) et la lecture d'une fiche
        // précise. Le `where` les distingue.
        findFirst: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
          if (!args?.where?.id) return { id: KALOUM };
          fiche = args.where;
          return maisons.find((m) => m.id === args.where!.id) ?? null;
        }),
        findMany: jest.fn(async (args: { where: unknown }) => {
          filtre = args.where;
          return maisons;
        }),
      },
      systemSettings: {
        findUnique: jest.fn(async () => ({ id: 'system' })),
      },
    };

    const service = new SettingsService(
      prisma as unknown as PrismaService,
      { get: jest.fn(), set: jest.fn(), del: jest.fn(), delByPattern: jest.fn() } as unknown as RedisService,
      { record: jest.fn() } as unknown as AuditService,
      { get: () => 600 } as never,
      new RestaurantScopeService(
        prisma as unknown as PrismaService,
        new RestaurantRouter(prisma as unknown as PrismaService),
      ),
    );

    return { service, filtre: () => filtre, fiche: () => fiche };
  }

  it('rend toutes les adresses, et désigne celle dont la carte est servie', async () => {
    const { service } = monter([maison(KALOUM, 'Le Bercail'), maison(KIPE, 'Le Bercail — Kipé')]);

    const adresses = await service.listPublicLocations();

    expect(adresses.map((a) => a.id)).toEqual([KALOUM, KIPE]);
    expect(adresses.filter((a) => a.isPrimary).map((a) => a.id)).toEqual([KALOUM]);
  });

  it('écarte les adresses fermées définitivement et les supprimées', async () => {
    const { service, filtre } = monter([maison(KALOUM, 'Le Bercail')]);

    await service.listPublicLocations();

    expect(filtre()).toEqual({ isActive: true, deletedAt: null });
  });

  it('juge l’ouverture adresse par adresse', async () => {
    // Le lundi, Kaloum sert et Kipé est fermé : une seule réponse pour
    // les deux afficherait « Ouvert maintenant » sur une porte close.
    const lundi = new Date(Date.UTC(2026, 8, 7, 12, 0));
    jest.useFakeTimers().setSystemTime(lundi);

    const heures = (weekday: number, isClosed: boolean) => [
      { weekday, opensAt: '08:00', closesAt: '23:00', isClosed },
    ];

    const { service } = monter([
      maison(KALOUM, 'Le Bercail', { openingHours: heures(1, false) }),
      maison(KIPE, 'Le Bercail — Kipé', { openingHours: heures(1, true) }),
    ]);

    const adresses = await service.listPublicLocations();

    expect(adresses.map((a) => a.isOpenNow)).toEqual([true, false]);
    jest.useRealTimers();
  });

  it('ouvre la fiche de l’adresse demandée, pas celle de la maison servie', async () => {
    // Le défaut qu'on évite : la fiche de Kipé affichant les horaires,
    // le téléphone et les frais de Kaloum sous le nom de Kipé — une
    // erreur invisible, qui envoie quelqu'un devant une porte fermée.
    const { service } = monter([
      maison(KALOUM, 'Le Bercail'),
      maison(KIPE, 'Le Bercail — Kipé'),
    ]);

    const adresse = await service.getPublicLocation(KIPE);

    expect(adresse.id).toBe(KIPE);
    expect(adresse.name).toBe('Le Bercail — Kipé');
    expect(adresse.isPrimary).toBe(false);
  });

  it('désigne la maison servie sur sa propre fiche', async () => {
    // C'est ce drapeau qui décide si « Voir le menu » a un sens : la
    // carte servie est celle de cette maison-là, et d'aucune autre.
    const { service } = monter([maison(KALOUM, 'Le Bercail')]);

    expect((await service.getPublicLocation(KALOUM)).isPrimary).toBe(true);
  });

  it('refuse une adresse fermée, supprimée ou inventée', async () => {
    const { service, fiche } = monter([maison(KALOUM, 'Le Bercail')]);

    await expect(service.getPublicLocation('matoto')).rejects.toThrow(
      /n’existe pas ou n’est plus ouverte/,
    );
    expect(fiche()).toEqual({ id: 'matoto', isActive: true, deletedAt: null });
  });

  it('ne publie ni frais de livraison ni minimum de commande', async () => {
    // Ils appartiennent à l'établissement qui prend la commande. Les
    // exposer par adresse laisserait croire qu'on peut commander dans
    // chacune, ce que l'application ne sait pas faire.
    const { service } = monter([maison(KALOUM, 'Le Bercail')]);

    const [adresse] = await service.listPublicLocations();

    expect(Object.keys(adresse)).not.toContain('deliveryFee');
    expect(Object.keys(adresse)).not.toContain('minimumOrder');
    expect(Object.keys(adresse)).not.toContain('minimumOrderAmount');
  });
});
