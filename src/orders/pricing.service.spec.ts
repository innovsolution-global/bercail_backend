import { OrderType, PromotionType } from '@prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { PricingService } from './pricing.service';

/**
 * Le moteur de prix est l'endroit où se joue la règle la plus importante
 * du contrat : **le serveur est seul juge des montants**. Ces tests
 * décrivent son comportement à partir de données en base simulées.
 */
describe('PricingService', () => {
  const restaurant = {
    id: 'restaurant-1',
    deliveryFee: 15000,
    freeDeliveryThreshold: 300000,
    minimumOrderAmount: 50000,
    averagePreparationMinutes: 25,
    averageDeliveryMinutes: 30,
    currency: 'GNF',
  };

  const pouletBraise = {
    id: 'item-poulet',
    name: 'Poulet braisé',
    price: 145000,
    promoPrice: null as number | null,
    imageUrl: '',
    isAvailable: true,
    preparationMinutes: 35,
    optionGroups: [
      {
        id: 'group-accompagnement',
        name: 'Accompagnement',
        isRequired: true,
        minSelect: 1,
        maxSelect: 1,
        options: [
          { id: 'opt-riz', name: 'Riz gras', extraPrice: 0, isAvailable: true },
          { id: 'opt-alloco', name: 'Alloco', extraPrice: 5000, isAvailable: true },
          { id: 'opt-rupture', name: 'Frites', extraPrice: 5000, isAvailable: false },
        ],
      },
      {
        id: 'group-sauce',
        name: 'Sauce',
        isRequired: false,
        minSelect: 0,
        maxSelect: 2,
        options: [
          { id: 'opt-piment', name: 'Sauce piment', extraPrice: 0, isAvailable: true },
          { id: 'opt-arachide', name: 'Sauce arachide', extraPrice: 8000, isAvailable: true },
        ],
      },
    ],
  };

  const jus = {
    id: 'item-jus',
    name: 'Jus de gingembre',
    price: 20000,
    promoPrice: 15000,
    imageUrl: '',
    isAvailable: true,
    preparationMinutes: 3,
    optionGroups: [],
  };

  function buildService(options: { items?: unknown[]; promotion?: unknown; usages?: number } = {}) {
    const prisma = {
      menuItem: { findMany: jest.fn().mockResolvedValue(options.items ?? [pouletBraise, jus]) },
      promotion: { findFirst: jest.fn().mockResolvedValue(options.promotion ?? null) },
      couponUsage: { count: jest.fn().mockResolvedValue(options.usages ?? 0) },
    };

    const settings = { getRestaurantCached: jest.fn().mockResolvedValue(restaurant) };

    const service = new PricingService(
      prisma as never,
      settings as never,
    );

    return { service, prisma };
  }

  describe('calcul du panier', () => {
    it('additionne prix, suppléments et quantités', async () => {
      const { service } = buildService();

      const quote = await service.quote({
        lines: [
          { menuItemId: 'item-poulet', quantity: 2, optionIds: ['opt-alloco', 'opt-arachide'] },
        ],
        orderType: OrderType.DELIVERY,
      });

      // (145 000 + 5 000 + 8 000) × 2 = 316 000
      expect(quote.subtotal).toBe(316000);
      expect(quote.lines[0].lineTotal).toBe(316000);
      // Au-delà du seuil : livraison offerte.
      expect(quote.deliveryFee).toBe(0);
      expect(quote.total).toBe(316000);
    });

    it('applique le prix promotionnel plutôt que le prix catalogue', async () => {
      const { service } = buildService();

      const quote = await service.quote({
        lines: [{ menuItemId: 'item-jus', quantity: 3 }],
        orderType: OrderType.PICKUP,
      });

      expect(quote.lines[0].unitPrice).toBe(15000);
      expect(quote.subtotal).toBe(45000);
    });

    it('facture la livraison sous le seuil de gratuité', async () => {
      const { service } = buildService();

      const quote = await service.quote({
        lines: [{ menuItemId: 'item-jus', quantity: 2 }],
        orderType: OrderType.DELIVERY,
      });

      expect(quote.deliveryFee).toBe(15000);
      expect(quote.total).toBe(30000 + 15000);
    });

    it('ne facture aucune livraison pour un retrait sur place', async () => {
      const { service } = buildService();

      const quote = await service.quote({
        lines: [{ menuItemId: 'item-jus', quantity: 1 }],
        orderType: OrderType.PICKUP,
      });

      expect(quote.deliveryFee).toBe(0);
    });

    it('retient la durée de préparation la plus longue du panier', async () => {
      const { service } = buildService();

      const quote = await service.quote({
        lines: [
          { menuItemId: 'item-jus', quantity: 1 },
          { menuItemId: 'item-poulet', quantity: 1, optionIds: ['opt-riz'] },
        ],
        orderType: OrderType.PICKUP,
      });

      expect(quote.estimatedPreparationMinutes).toBe(35);
    });
  });

  describe('validation des options', () => {
    it('exige les groupes obligatoires', async () => {
      const { service } = buildService();

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-poulet', quantity: 1, optionIds: [] }],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(/Choisissez « Accompagnement »/);
    });

    it('refuse une option qui n’appartient pas au plat', async () => {
      const { service } = buildService();

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 1, optionIds: ['opt-alloco'] }],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(/n'appartient pas au plat/);
    });

    it('refuse une option en rupture', async () => {
      const { service } = buildService();

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-poulet', quantity: 1, optionIds: ['opt-rupture'] }],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(/n'est plus disponible/);
    });

    it('respecte le nombre maximum de choix d’un groupe', async () => {
      const { service } = buildService({
        items: [
          {
            ...pouletBraise,
            optionGroups: [
              {
                ...pouletBraise.optionGroups[1],
                maxSelect: 1,
              },
              pouletBraise.optionGroups[0],
            ],
          },
        ],
      });

      await expect(
        service.quote({
          lines: [
            {
              menuItemId: 'item-poulet',
              quantity: 1,
              optionIds: ['opt-piment', 'opt-arachide', 'opt-riz'],
            },
          ],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(/au maximum 1 choix/);
    });
  });

  describe('disponibilité', () => {
    it('refuse un plat indisponible', async () => {
      const { service } = buildService({ items: [{ ...jus, isAvailable: false }] });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 1 }],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(/n'est plus disponible/);
    });

    it('refuse un plat inexistant', async () => {
      const { service } = buildService({ items: [] });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-fantome', quantity: 1 }],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(AppException);
    });

    it('refuse un panier vide', async () => {
      const { service } = buildService();

      await expect(
        service.quote({ lines: [], orderType: OrderType.DELIVERY }),
      ).rejects.toThrow(/panier est vide/);
    });
  });

  describe('promotions', () => {
    const activePromotion = {
      id: 'promo-1',
      code: 'BIENVENUE10',
      name: 'Bienvenue',
      type: PromotionType.PERCENTAGE,
      value: 10,
      minimumOrder: 50000,
      maxDiscount: 20000,
      usageLimit: null,
      usageCount: 0,
      perCustomerLimit: null,
      isActive: true,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      deletedAt: null,
    };

    it('applique un pourcentage plafonné', async () => {
      const { service } = buildService({ promotion: activePromotion });

      const quote = await service.quote({
        lines: [{ menuItemId: 'item-poulet', quantity: 2, optionIds: ['opt-riz'] }],
        orderType: OrderType.DELIVERY,
        promotionCode: 'BIENVENUE10',
      });

      // 10 % de 290 000 = 29 000, plafonné à 20 000.
      expect(quote.discount).toBe(20000);
      // 290 000 est sous le seuil de gratuité : la livraison reste facturée.
      expect(quote.deliveryFee).toBe(15000);
      expect(quote.total).toBe(290000 + 15000 - 20000);
    });

    it('offre les frais de livraison pour une promotion de type free_delivery', async () => {
      const { service } = buildService({
        promotion: { ...activePromotion, type: PromotionType.FREE_DELIVERY, value: 0 },
      });

      const quote = await service.quote({
        lines: [{ menuItemId: 'item-jus', quantity: 4 }],
        orderType: OrderType.DELIVERY,
        promotionCode: 'LIVRAISON0',
      });

      expect(quote.deliveryFee).toBe(15000);
      expect(quote.discount).toBe(15000);
      expect(quote.total).toBe(60000);
    });

    it('refuse une promotion expirée', async () => {
      const { service } = buildService({
        promotion: {
          ...activePromotion,
          startsAt: new Date(Date.now() - 10 * 86_400_000),
          endsAt: new Date(Date.now() - 86_400_000),
        },
      });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 4 }],
          orderType: OrderType.DELIVERY,
          promotionCode: 'BIENVENUE10',
        }),
      ).rejects.toThrow(/n'est plus valable/);
    });

    it('refuse une promotion sous son minimum de commande', async () => {
      const { service } = buildService({
        promotion: { ...activePromotion, minimumOrder: 500000 },
      });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 1 }],
          orderType: OrderType.DELIVERY,
          promotionCode: 'BIENVENUE10',
        }),
      ).rejects.toThrow(/s'applique à partir de/);
    });

    it('refuse une promotion dont le quota global est atteint', async () => {
      const { service } = buildService({
        promotion: { ...activePromotion, usageLimit: 10, usageCount: 10 },
      });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 4 }],
          orderType: OrderType.DELIVERY,
          promotionCode: 'BIENVENUE10',
        }),
      ).rejects.toThrow(/limite d’utilisation/);
    });

    it('refuse une promotion déjà utilisée par ce client', async () => {
      const { service } = buildService({
        promotion: { ...activePromotion, perCustomerLimit: 1 },
        usages: 1,
      });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 4 }],
          orderType: OrderType.DELIVERY,
          promotionCode: 'BIENVENUE10',
          customerId: 'client-1',
        }),
      ).rejects.toThrow(/déjà utilisé ce code/);
    });

    it('refuse un code inconnu plutôt que de l’ignorer en silence', async () => {
      const { service } = buildService({ promotion: null });

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 4 }],
          orderType: OrderType.DELIVERY,
          promotionCode: 'INEXISTANT',
        }),
      ).rejects.toThrow(/code promotionnel est invalide/);
    });
  });

  describe('quantités', () => {
    it('refuse une quantité hors bornes', async () => {
      const { service } = buildService();

      await expect(
        service.quote({
          lines: [{ menuItemId: 'item-jus', quantity: 999 }],
          orderType: OrderType.DELIVERY,
        }),
      ).rejects.toThrow(/entre 1 et 50/);
    });
  });
});
