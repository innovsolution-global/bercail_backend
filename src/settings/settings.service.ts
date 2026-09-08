import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpeningHour, Restaurant, SystemSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
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
  ) {}

  async onModuleInit(): Promise<void> {
    // Le cache doit repartir propre après un redéploiement.
    await this.redis.del(RESTAURANT_CACHE_KEY, SYSTEM_CACHE_KEY);
  }

  // ─────────────────────────────── Lecture ────────────────────────────────

  /** Restaurant courant, avec ses horaires. Lève si la base n'est pas semée. */
  async getRestaurant(): Promise<RestaurantWithHours> {
    const restaurant = await this.prisma.restaurant.findFirst({
      include: { openingHours: { orderBy: { weekday: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });

    if (!restaurant) {
      throw AppException.notFound(
        "Le restaurant n'est pas configuré. Exécutez le seed avant de démarrer.",
      );
    }

    return restaurant;
  }

  /** Version mise en cache, utilisée dans le chemin critique des commandes. */
  async getRestaurantCached(): Promise<RestaurantWithHours> {
    const ttl = this.config.get<number>('cache.settingsTtlSeconds') ?? 600;
    const cached = await this.redis.get<RestaurantWithHours>(RESTAURANT_CACHE_KEY);
    if (cached) {
      return {
        ...cached,
        createdAt: new Date(cached.createdAt),
        updatedAt: new Date(cached.updatedAt),
      };
    }

    const restaurant = await this.getRestaurant();
    await this.redis.set(RESTAURANT_CACHE_KEY, restaurant, ttl);
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
    const restaurant = await this.getRestaurantCached();
    const settings = this.toRestaurantSettingsDto(restaurant);
    return {
      ...settings,
      isOpenNow: this.isOpenNow(restaurant),
    };
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

    await this.redis.del(RESTAURANT_CACHE_KEY);

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

  async assertOpenForOrders(): Promise<RestaurantWithHours> {
    const restaurant = await this.getRestaurantCached();
    if (!this.isOpenNow(restaurant)) {
      throw AppException.conflict(
        ERROR_CODES.RESTAURANT_CLOSED,
        'Le restaurant est actuellement fermé. Réessayez pendant les heures de service.',
      );
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
