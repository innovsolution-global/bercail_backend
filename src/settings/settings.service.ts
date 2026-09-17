import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpeningHour, Restaurant, SystemSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RestaurantScopeService } from '../common/context/restaurant-scope.service';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { UpdateRestaurantSettingsDto, UpdateSystemSettingsDto } from './dto/settings.dto';

const RESTAURANT_CACHE_KEY = 'settings:restaurant';
const SYSTEM_CACHE_KEY = 'settings:system';

type RestaurantWithHours = Restaurant & { openingHours: OpeningHour[] };

/**
 * Paramètres du restaurant et du système.
 *
 * Le restaurant est un singleton : la plateforme gère un établissement,
 * « Le Bercail ». Le modèle reste une table pour pouvoir en accueillir
 * plusieurs plus tard sans migration douloureuse.
 *
 * Ces réglages sont lus à chaque commande (frais de livraison, minimum,
 * horaires) : ils sont donc mis en cache, et le cache est invalidé à
 * chaque écriture.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly scope: RestaurantScopeService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Le cache doit repartir propre après un redéploiement. Par motif :
    // il y a désormais une entrée par établissement.
    await this.redis.delByPattern(`${RESTAURANT_CACHE_KEY}*`);
    await this.redis.del(SYSTEM_CACHE_KEY);
  }

  // ─────────────────────────────── Lecture ────────────────────────────────

  /**
   * Le restaurant dont parle la requête, avec ses horaires.
   *
   * **Celui du compte**, et non plus le plus ancien : cette méthode sert
   * aussi bien la fiche publique que l'écran « Réglages » du back-office,
   * où elle décidait jusqu'ici de la maison **modifiée**. Un ADMIN de la
   * seconde adresse y changeait donc les horaires, les frais de livraison
   * et le minimum de commande de la première, sans qu'aucun écran ne le
   * laisse deviner.
   *
   * Lève si la base n'est pas semée.
   */
  async getRestaurant(): Promise<RestaurantWithHours> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: await this.scope.restaurantForRequest() },
      include: { openingHours: { orderBy: { weekday: 'asc' } } },
    });

    if (!restaurant) {
      throw AppException.notFound(
        "Le restaurant n'est pas configuré. Exécutez le seed avant de démarrer.",
      );
    }

    return restaurant;
  }

  /**
   * Version mise en cache, utilisée dans le chemin critique des commandes.
   *
   * Une entrée **par établissement** : une clé unique servirait la fiche
   * de la première maison lue à toutes les autres — donc ses frais de
   * livraison et son minimum de commande, appliqués à des commandes qui
   * ne la concernent pas.
   */
  async getRestaurantCached(): Promise<RestaurantWithHours> {
    const ttl = this.config.get<number>('cache.settingsTtlSeconds') ?? 600;
    const cacheKey = `${RESTAURANT_CACHE_KEY}:${await this.scope.restaurantForRequest()}`;

    const cached = await this.redis.get<RestaurantWithHours>(cacheKey);
    if (cached) {
      return {
        ...cached,
        createdAt: new Date(cached.createdAt),
        updatedAt: new Date(cached.updatedAt),
      };
    }

    const restaurant = await this.getRestaurant();
    await this.redis.set(cacheKey, restaurant, ttl);
    return restaurant;
  }

  async getSystemSettings(): Promise<SystemSettings> {
    const existing = await this.prisma.systemSettings.findUnique({ where: { id: 'system' } });
    if (existing) return existing;
    return this.prisma.systemSettings.create({ data: { id: 'system' } });
  }

  // ────────────────────────────── Sérialisation ───────────────────────────

  toRestaurantSettingsDto(restaurant: RestaurantWithHours) {
    return {
      id: restaurant.id,
      name: restaurant.name,
      tagline: restaurant.tagline,
      description: restaurant.description,
      logoUrl: restaurant.logoUrl,
      coverImageUrl: restaurant.coverImageUrl,
      phone: restaurant.phone,
      email: restaurant.email,
      address: restaurant.address,
      district: restaurant.district,
      city: restaurant.city,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      openingHours: restaurant.openingHours.map((hour) => ({
        weekday: hour.weekday,
        opensAt: hour.opensAt,
        closesAt: hour.closesAt,
        isClosed: hour.isClosed,
      })),
      isOpen: restaurant.isOpen,
      deliveryEnabled: restaurant.deliveryEnabled,
      pickupEnabled: restaurant.pickupEnabled,
      deliveryFee: restaurant.deliveryFee,
      freeDeliveryThreshold: restaurant.freeDeliveryThreshold,
      minimumOrder: restaurant.minimumOrderAmount,
      averagePreparationMinutes: restaurant.averagePreparationMinutes,
      averageDeliveryMinutes: restaurant.averageDeliveryMinutes,
      deliveryZones: restaurant.deliveryZones,
      // La note laissée par les clients, nulle tant que personne n'a
      // noté. La fiche affichait autrefois « 4,8 · 1 240 avis » écrit en
      // dur ; ceci est le vrai chiffre, ou rien.
      rating: restaurant.rating,
      reviewCount: restaurant.reviewCount,
      currency: restaurant.currency,
    };
  }

  toSystemSettingsDto(settings: SystemSettings) {
    return {
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: settings.maintenanceMessage,
      sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
      passwordMinLength: settings.passwordMinLength,
      requireTwoFactor: settings.requireTwoFactor,
      maxLoginAttempts: settings.maxLoginAttempts,
      auditRetentionDays: settings.auditRetentionDays,
      notifications: {
        emailEnabled: settings.emailEnabled,
        smsEnabled: settings.smsEnabled,
        pushEnabled: settings.pushEnabled,
        newOrderSound: settings.newOrderSound,
      },
      integrations: {
        orangeMoneyEnabled: settings.orangeMoneyEnabled,
        mtnMoneyEnabled: settings.mtnMoneyEnabled,
        cardPaymentEnabled: settings.cardPaymentEnabled,
        mapsProvider: settings.mapsProvider as 'osm' | 'google' | 'none',
      },
    };
  }

  /** Vue publique, consommée par l'application Flutter. */
  async getPublicRestaurant() {
    return this.toPublicFiche(await this.getRestaurantCached());
  }

  /**
   * La fiche publique d'une adresse **précise**.
   *
   * `getPublicRestaurant()` ne sait parler que de l'établissement servi
   * au public. Le plan, lui, montre toutes les adresses de l'enseigne :
   * il fallait bien pouvoir ouvrir celle sur laquelle on vient
   * d'appuyer. Sans cette route, la fiche de Kipé aurait affiché les
   * horaires, le téléphone et les frais de Kaloum sous le nom de Kipé —
   * une erreur invisible, et qui envoie quelqu'un devant une porte
   * fermée.
   *
   * Pas de cache ici : une fiche consultée à la demande ne justifie pas
   * une entrée de plus par établissement, et celle qui compte — la
   * maison servie, sur le chemin des commandes — garde la sienne.
   */
  async getPublicLocation(id: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: { openingHours: { orderBy: { weekday: 'asc' } } },
    });

    if (!restaurant) {
      throw AppException.notFound('Cette adresse n’existe pas ou n’est plus ouverte.');
    }

    return this.toPublicFiche(restaurant);
  }

  /** Ce qu'une fiche publique montre, quelle que soit l'adresse. */
  private async toPublicFiche(restaurant: RestaurantWithHours) {
    const settings = this.toRestaurantSettingsDto(restaurant);
    const system = await this.getSystemSettings();

    return {
      ...settings,
      isOpenNow: this.isOpenNow(restaurant),
      /**
       * L'établissement dont l'application sert la carte.
       *
       * L'application s'en sert pour savoir si « Voir le menu » a un
       * sens sur cette fiche : la carte, les prix et les frais servis
       * sont ceux de cette maison-là, et d'aucune autre.
       */
      isPrimary: restaurant.id === (await this.scope.publicRestaurantId()),
      /**
       * Les moyens de paiement réellement proposables, dans l'ordre
       * d'affichage.
       *
       * L'application les listait en dur, si bien que désactiver un
       * opérateur en back-office ne la faisait pas changer d'avis :
       * elle laissait choisir un moyen que la création de commande
       * refusait ensuite en `PAYMENT_METHOD_DISABLED`. Le refus arrivait
       * donc **après** le récapitulatif, au pire moment.
       *
       * Le paiement à la livraison n'a pas d'interrupteur : il ne
       * dépend d'aucun opérateur, seulement d'un livreur qui encaisse.
       */
      paymentMethods: [
        ...(system.orangeMoneyEnabled ? ['orange_money'] : []),
        ...(system.mtnMoneyEnabled ? ['mtn_money'] : []),
        ...(system.cardPaymentEnabled ? ['card'] : []),
        'cash_on_delivery',
      ],
    };
  }

  /**
   * Toutes les adresses de l'enseigne, pour le plan de l'application.
   *
   * La fiche publique ne parle que d'**un** établissement — le plus
   * ancien, celui dont l'application sert la carte (voir
   * [[RestaurantScopeService.publicRestaurantId]]). L'onglet
   * « Localisation » ne posait donc qu'un seul repère sur son plan,
   * alors que l'enseigne en compte plusieurs : les autres adresses
   * existaient en base, apparaissaient au back-office, et restaient
   * invisibles au client.
   *
   * Cette liste est **délibérément maigre** : de quoi poser un repère,
   * dire si l'on y sert en ce moment et lancer un itinéraire. Les frais
   * de livraison, le minimum de commande et les moyens de paiement n'y
   * sont pas — ils appartiennent à l'établissement qui prend la
   * commande, et les publier ici laisserait croire qu'on peut commander
   * dans chacun.
   *
   * `isPrimary` désigne celui-là, pour que l'application sache lequel de
   * ses repères correspond à la carte qu'elle affiche.
   */
  async listPublicLocations() {
    const [restaurants, primaryId] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: { isActive: true, deletedAt: null },
        include: { openingHours: { orderBy: { weekday: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.scope.publicRestaurantId(),
    ]);

    return restaurants.map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      tagline: restaurant.tagline,
      logoUrl: restaurant.logoUrl,
      coverImageUrl: restaurant.coverImageUrl,
      phone: restaurant.phone,
      address: restaurant.address,
      district: restaurant.district,
      city: restaurant.city,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      // Calculé ici, établissement par établissement : deux adresses de
      // la même enseigne n'ouvrent pas forcément aux mêmes heures.
      isOpenNow: this.isOpenNow(restaurant),
      deliveryEnabled: restaurant.deliveryEnabled,
      pickupEnabled: restaurant.pickupEnabled,
      isPrimary: restaurant.id === primaryId,
    }));
  }

  // ─────────────────────────────── Écriture ───────────────────────────────

  async updateRestaurant(
    dto: UpdateRestaurantSettingsDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const restaurant = await this.getRestaurant();
    const { openingHours, minimumOrder, ...rest } = dto;

    const updated = await this.prisma.transaction(async (tx) => {
      const saved = await tx.restaurant.update({
        where: { id: restaurant.id },
        data: {
          ...rest,
          ...(minimumOrder !== undefined ? { minimumOrderAmount: minimumOrder } : {}),
        },
      });

      if (openingHours) {
        for (const hour of openingHours) {
          await tx.openingHour.upsert({
            where: { restaurantId_weekday: { restaurantId: restaurant.id, weekday: hour.weekday } },
            update: { opensAt: hour.opensAt, closesAt: hour.closesAt, isClosed: hour.isClosed },
            create: {
              restaurantId: restaurant.id,
              weekday: hour.weekday,
              opensAt: hour.opensAt,
              closesAt: hour.closesAt,
              isClosed: hour.isClosed,
            },
          });
        }
      }

      return saved;
    });

    await this.redis.del(`${RESTAURANT_CACHE_KEY}:${restaurant.id}`);

    await this.audit.record({
      actor,
      action: 'SETTINGS_RESTAURANT_UPDATE',
      module: 'settings',
      entityType: 'Restaurant',
      entityId: restaurant.id,
      oldValue: this.auditableRestaurant(restaurant),
      newValue: this.auditableRestaurant({ ...restaurant, ...updated }),
      context,
    });

    const fresh = await this.getRestaurant();
    return this.toRestaurantSettingsDto(fresh);
  }

  async updateSystemSettings(
    dto: UpdateSystemSettingsDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const current = await this.getSystemSettings();
    const { notifications, integrations, ...rest } = dto;

    const updated = await this.prisma.systemSettings.update({
      where: { id: 'system' },
      data: {
        ...rest,
        ...(notifications
          ? {
              emailEnabled: notifications.emailEnabled,
              smsEnabled: notifications.smsEnabled,
              pushEnabled: notifications.pushEnabled,
              newOrderSound: notifications.newOrderSound,
            }
          : {}),
        ...(integrations
          ? {
              orangeMoneyEnabled: integrations.orangeMoneyEnabled,
              mtnMoneyEnabled: integrations.mtnMoneyEnabled,
              cardPaymentEnabled: integrations.cardPaymentEnabled,
              mapsProvider: integrations.mapsProvider,
            }
          : {}),
      },
    });

    await this.redis.del(SYSTEM_CACHE_KEY);

    // Les paramètres système touchent la sécurité : l'audit est intégral.
    await this.audit.record({
      actor,
      action: 'SETTINGS_SYSTEM_UPDATE',
      module: 'settings',
      entityType: 'SystemSettings',
      entityId: 'system',
      oldValue: current,
      newValue: updated,
      context,
    });

    if (dto.maintenanceMode !== undefined && dto.maintenanceMode !== current.maintenanceMode) {
      this.logger.warn(
        `Mode maintenance ${dto.maintenanceMode ? 'ACTIVÉ' : 'désactivé'} par ${actor.email}.`,
      );
    }

    return this.toSystemSettingsDto(updated);
  }

  // ──────────────────────────── Règles métier ─────────────────────────────

  /**
   * Le restaurant accepte-t-il des commandes maintenant ?
   *
   * Deux conditions : l'interrupteur manuel (`isOpen`, que le gestionnaire
   * peut couper à tout moment) et la plage horaire du jour.
   */
  isOpenNow(restaurant: RestaurantWithHours, now: Date = new Date()): boolean {
    if (!restaurant.isOpen) return false;

    // getUTCDay() : 0 = dimanche. La base suit ISO-8601 (1 = lundi, 7 = dimanche).
    const weekday = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
    const today = restaurant.openingHours.find((hour) => hour.weekday === weekday);
    if (!today) return true;
    if (today.isClosed) return false;

    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const opens = this.toMinutes(today.opensAt);
    const closes = this.toMinutes(today.closesAt);

    // Service qui déborde après minuit (ex. 18:00 → 02:00).
    if (closes < opens) return minutes >= opens || minutes < closes;
    return minutes >= opens && minutes < closes;
  }

  async assertOpenForOrders(restaurantId?: string | null): Promise<RestaurantWithHours> {
    const restaurant = restaurantId
        ? await this.byId(restaurantId)
        : await this.getRestaurantCached();
    this.assertOpen(restaurant);
    return restaurant;
  }

  /** Refuse une commande hors des heures de service de cette maison. */
  assertOpen(restaurant: RestaurantWithHours): void {
    if (!this.isOpenNow(restaurant)) {
      throw AppException.conflict(
        ERROR_CODES.RESTAURANT_CLOSED,
        'Le restaurant est actuellement fermé. Réessayez pendant les heures de service.',
      );
    }
  }

  /**
   * Un établissement précis, avec ses horaires.
   *
   * Utilisé par la création de commande : la maison qui cuisine est
   * celle dont viennent les plats du panier, et c'est **ses** horaires,
   * **ses** frais et **son** minimum qui s'appliquent — pas ceux de la
   * maison que le contexte aurait désignée.
   */
  async byId(restaurantId: string): Promise<RestaurantWithHours> {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, isActive: true, deletedAt: null },
      include: { openingHours: { orderBy: { weekday: 'asc' } } },
    });

    if (!restaurant) {
      throw AppException.notFound('Cet établissement n’est plus ouvert.');
    }

    return restaurant;
  }

  async isMaintenanceMode(): Promise<boolean> {
    const settings = await this.getSystemSettings();
    return settings.maintenanceMode;
  }

  private toMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map((part) => Number.parseInt(part, 10));
    return hours * 60 + minutes;
  }

  private auditableRestaurant(restaurant: Restaurant) {
    return {
      name: restaurant.name,
      phone: restaurant.phone,
      email: restaurant.email,
      address: restaurant.address,
      // Déplacer le restaurant change les frais et les zones de livraison :
      // la position mérite d'être tracée comme le reste.
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      isOpen: restaurant.isOpen,
      deliveryEnabled: restaurant.deliveryEnabled,
      pickupEnabled: restaurant.pickupEnabled,
      deliveryFee: restaurant.deliveryFee,
      freeDeliveryThreshold: restaurant.freeDeliveryThreshold,
      minimumOrderAmount: restaurant.minimumOrderAmount,
      averagePreparationMinutes: restaurant.averagePreparationMinutes,
      averageDeliveryMinutes: restaurant.averageDeliveryMinutes,
      deliveryZones: restaurant.deliveryZones,
    };
  }
}
