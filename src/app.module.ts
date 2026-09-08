import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AddressesModule } from './addresses/addresses.module';
import { AdminsModule } from './admins/admins.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CartsModule } from './carts/carts.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PasswordChangeGuard } from './common/guards/password-change.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ThrottlerBehindProxyGuard } from './common/guards/throttler-proxy.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RestaurantScopeInterceptor } from './common/interceptors/restaurant-scope.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RestaurantScopeMiddleware } from './common/middleware/restaurant-scope.middleware';
import { createValidationPipe } from './common/pipes/validation.pipe';
import { MaintenanceService } from './common/tasks/maintenance.service';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { CustomersModule } from './customers/customers.module';
import { PrismaModule } from './database/prisma.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { DriversModule } from './drivers/drivers.module';
import { FavoritesModule } from './favorites/favorites.module';
import { FinanceModule } from './finance/finance.module';
import { HealthModule } from './health/health.module';
import { MenuModule } from './menu/menu.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PromotionsModule } from './promotions/promotions.module';
import { RbacModule } from './rbac/rbac.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage';
import { RedisService } from './redis/redis.service';
import { ReportsModule } from './reports/reports.module';
import { SearchModule } from './search/search.module';
import { SettingsModule } from './settings/settings.module';
import { StorageModule } from './storage/storage.module';
import { SyncModule } from './sync/sync.module';

/**
 * Assemblage de l'application.
 *
 * Les quatre barrières d'autorisation sont montées globalement, dans cet
 * ordre : authentification → mot de passe à changer → rôle → permission.
 * L'appartenance (ownership), elle, se vérifie dans les services, au plus
 * près de la donnée.
 *
 * Conséquence : toute nouvelle route est protégée par défaut. Il faut un
 * `@Public()` explicite pour l'ouvrir — l'oubli ferme, il n'ouvre pas.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
      cache: true,
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService, redis: RedisService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('throttle.ttlSeconds') ?? 60) * 1000,
            limit: config.get<number>('throttle.limit') ?? 120,
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),

    ScheduleModule.forRoot(),

    // Socle technique
    PrismaModule,
    RedisModule,
    CommonModule,
    AuditModule,
    RealtimeModule,
    MailModule,
    NotificationsModule,
    StorageModule,
    SettingsModule,
    RbacModule,
    SyncModule,

    // Domaines métier
    AuthModule,
    MenuModule,
    AddressesModule,
    FavoritesModule,
    CartsModule,
    OrdersModule,
    PaymentsModule,
    DeliveriesModule,
    DriversModule,
    CustomersModule,
    AdminsModule,
    PromotionsModule,
    FinanceModule,
    ReportsModule,
    SearchModule,
    HealthModule,
  ],
  providers: [
    MaintenanceService,

    // 1. Limitation de débit
    { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
    // 2. Authentification
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 3. Mot de passe temporaire à changer
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
    // 4. Rôle
    { provide: APP_GUARD, useClass: RolesGuard },
    // 5. Permission
    { provide: APP_GUARD, useClass: PermissionsGuard },

    // Validation des entrees : montee ici (et non dans `main.ts`) pour que
    // les tests appliquent exactement les memes regles que la production.
    { provide: APP_PIPE, useFactory: createValidationPipe },

    // Avant tout le reste : il ouvre le périmètre d'établissement dans
    // lequel les intercepteurs suivants et le contrôleur s'exécuteront.
    { provide: APP_INTERCEPTOR, useClass: RestaurantScopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Syntaxe Express 5 : `*` seul n'est plus un motif valide.
    consumer
      .apply(RequestContextMiddleware, RestaurantScopeMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
