import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../../src/app.module';

/**
 * Socle des tests de bout en bout.
 *
 * L'application est démarrée exactement comme en production (mêmes
 * guards, mêmes pipes, même filtre d'exception) : un test qui passe ici
 * décrit le comportement réel de l'API, pas celui d'un montage allégé.
 *
 * ⚠️ Ces tests exigent une base PostgreSQL accessible via DATABASE_URL,
 * et ils la modifient. Utilisez une base dédiée (voir docker-compose).
 */
export const API_PREFIX = 'api/v1';

// Les suites enchainent volontairement les connexions : sans cela, la
// limitation de debit les bloquerait. Elle est verifiee separement, et
// cette variable n'a aucun effet en production.
process.env.THROTTLE_DISABLED = 'true';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();

  // `AppModule` fournit déjà, en global, le middleware de contexte, les
  // guards, le pipe de validation, l'intercepteur de réponse et le filtre
  // d'exception. Les réenregistrer ici envelopperait les réponses deux fois
  // (`data.data`) : on se contente donc du préfixe d'API.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/live', 'health/ready'] });

  await app.init();
  return app;
}

export function api(app: INestApplication) {
  const server = app.getHttpServer();

  return {
    get: (path: string, token?: string) => withAuth(request(server).get(url(path)), token),
    post: (path: string, body?: unknown, token?: string) =>
      withAuth(request(server).post(url(path)).send(body ?? {}), token),
    patch: (path: string, body?: unknown, token?: string) =>
      withAuth(request(server).patch(url(path)).send(body ?? {}), token),
    delete: (path: string, token?: string) => withAuth(request(server).delete(url(path)), token),
  };
}

function url(path: string): string {
  return `/${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

function withAuth(test: request.Test, token?: string): request.Test {
  return token ? test.set('Authorization', `Bearer ${token}`) : test;
}

/** Connexion et récupération du jeton d'accès. */
export async function login(
  app: INestApplication,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string; user: Record<string, unknown> }> {
  const response = await api(app).post('/auth/login', { email, password }).expect(200);
  return response.body.data;
}

/**
 * Crée un compte directement en base.
 *
 * Indispensable pour les rôles que l'API refuse de créer publiquement :
 * c'est précisément ce que ces tests vérifient par ailleurs.
 */
export async function seedUser(
  prisma: PrismaClient,
  options: {
    role: Role;
    email: string;
    password: string;
    phone: string;
    firstName?: string;
    lastName?: string;
    status?: AccountStatus;
    driverCode?: string;
  },
) {
  return prisma.user.create({
    data: {
      firstName: options.firstName ?? 'Test',
      lastName: options.lastName ?? options.role,
      email: options.email,
      phone: options.phone,
      passwordHash: bcrypt.hashSync(options.password, 10),
      role: options.role,
      status: options.status ?? AccountStatus.ACTIVE,
      ...(options.role === Role.CUSTOMER
        ? { customerProfile: { create: {} }, cart: { create: {} } }
        : {}),
      ...(options.role === Role.DRIVER
        ? {
            driverProfile: {
              create: {
                driverCode: options.driverCode ?? `LIV-T${Math.floor(Math.random() * 900 + 100)}`,
                zone: 'Kaloum',
                isOnline: true,
                isAvailable: true,
              },
            },
          }
        : {}),
    },
    include: { driverProfile: true },
  });
}

/** Nettoyage entre deux suites : supprime les comptes de test créés. */
export async function cleanupUsers(prisma: PrismaClient, emailPattern: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { contains: emailPattern } },
    select: { id: true },
  });

  const ids = users.map((user) => user.id);
  if (ids.length === 0) return;

  await prisma.$transaction([
    prisma.deliveryVerificationCode.deleteMany({
      where: { delivery: { order: { customerId: { in: ids } } } },
    }),
    prisma.deliveryEvent.deleteMany({ where: { delivery: { order: { customerId: { in: ids } } } } }),
    prisma.driverLocation.deleteMany({ where: { driver: { userId: { in: ids } } } }),
    prisma.delivery.deleteMany({ where: { order: { customerId: { in: ids } } } }),
    prisma.paymentEvent.deleteMany({ where: { payment: { customerId: { in: ids } } } }),
    prisma.payment.deleteMany({ where: { customerId: { in: ids } } }),
    prisma.orderItemOption.deleteMany({ where: { orderItem: { order: { customerId: { in: ids } } } } }),
    prisma.orderItem.deleteMany({ where: { order: { customerId: { in: ids } } } }),
    prisma.orderStatusHistory.deleteMany({ where: { order: { customerId: { in: ids } } } }),
    prisma.couponUsage.deleteMany({ where: { userId: { in: ids } } }),
    prisma.order.deleteMany({ where: { customerId: { in: ids } } }),
    prisma.cartItemOption.deleteMany({ where: { cartItem: { cart: { userId: { in: ids } } } } }),
    prisma.cartItem.deleteMany({ where: { cart: { userId: { in: ids } } } }),
    prisma.cart.deleteMany({ where: { userId: { in: ids } } }),
    prisma.favorite.deleteMany({ where: { userId: { in: ids } } }),
    prisma.notification.deleteMany({ where: { userId: { in: ids } } }),
    prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } }),
    prisma.address.deleteMany({ where: { userId: { in: ids } } }),
    prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }),
    prisma.authToken.deleteMany({ where: { userId: { in: ids } } }),
    prisma.userPermission.deleteMany({ where: { userId: { in: ids } } }),
    prisma.idempotencyKey.deleteMany({ where: { userId: { in: ids } } }),
    prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }),
    prisma.driverProfile.deleteMany({ where: { userId: { in: ids } } }),
    prisma.customerProfile.deleteMany({ where: { userId: { in: ids } } }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ]);
}
