import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { api, cleanupUsers, createTestApp, login, seedUser } from './helpers/app.helper';

/**
 * Matrice d'autorisation — §78 du contrat.
 *
 * Chaque assertion correspond à une ligne du cahier des charges :
 * un rôle qui sort de son périmètre reçoit 403, et un utilisateur ne
 * peut jamais atteindre les données d'un autre.
 */
describe('RBAC (e2e)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const suffix = Date.now().toString().slice(-6);
  const password = 'Bercail@2024';

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();

    const customerA = await seedUser(prisma, {
      role: Role.CUSTOMER,
      email: `e2e.rbac.client.a.${suffix}@test.gn`,
      phone: `+2246981${suffix}`,
      password,
    });
    const customerB = await seedUser(prisma, {
      role: Role.CUSTOMER,
      email: `e2e.rbac.client.b.${suffix}@test.gn`,
      phone: `+2246982${suffix}`,
      password,
    });
    const driverA = await seedUser(prisma, {
      role: Role.DRIVER,
      email: `e2e.rbac.livreur.a.${suffix}@test.gn`,
      phone: `+2246983${suffix}`,
      password,
      driverCode: `LIV-A${suffix.slice(-3)}`,
    });
    const driverB = await seedUser(prisma, {
      role: Role.DRIVER,
      email: `e2e.rbac.livreur.b.${suffix}@test.gn`,
      phone: `+2246984${suffix}`,
      password,
      driverCode: `LIV-B${suffix.slice(-3)}`,
    });
    const admin = await seedUser(prisma, {
      role: Role.ADMIN,
      email: `e2e.rbac.admin.${suffix}@test.gn`,
      phone: `+2246985${suffix}`,
      password,
    });
    const superAdmin = await seedUser(prisma, {
      role: Role.SUPER_ADMIN,
      email: `e2e.rbac.super.${suffix}@test.gn`,
      phone: `+2246986${suffix}`,
      password,
    });

    ids.customerA = customerA.id;
    ids.customerB = customerB.id;
    ids.driverA = driverA.driverProfile!.id;
    ids.driverB = driverB.driverProfile!.id;
    ids.admin = admin.id;
    ids.superAdmin = superAdmin.id;

    for (const [key, user] of Object.entries({
      customerA,
      customerB,
      driverA,
      driverB,
      admin,
      superAdmin,
    })) {
      const session = await login(app, user.email, password);
      tokens[key] = session.accessToken;
    }
  });

  afterAll(async () => {
    await cleanupUsers(prisma, 'e2e.rbac.');
    await prisma.$disconnect();
    await app.close();
  });

  describe('un CUSTOMER ne franchit pas la frontière du back-office', () => {
    it.each([
      ['/orders?page=1', 'liste des commandes (renvoie les siennes)'],
      ['/customers', 'liste des clients'],
      ['/drivers', 'liste des livreurs'],
      ['/dashboard', 'tableau de bord'],
      ['/administrators', 'administrateurs'],
      ['/audit-logs', "journal d'audit"],
      ['/settings/system', 'paramètres système'],
    ])('%s', async (path) => {
      const response = await api(app).get(path, tokens.customerA);

      if (path.startsWith('/orders')) {
        // La route existe pour lui, mais ne renvoie que ses commandes.
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
        return;
      }

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });
  });

  describe('un DRIVER ne franchit pas la frontière du back-office', () => {
    it.each([
      '/customers',
      '/drivers',
      '/dashboard',
      '/administrators',
      '/audit-logs',
      '/deliveries',
      '/settings/system',
    ])('%s → 403', async (path) => {
      await api(app).get(path, tokens.driverA).expect(403);
    });
  });

  describe('un ADMIN ne peut pas administrer les administrateurs', () => {
    it('liste des administrateurs → 403', async () => {
      await api(app).get('/administrators', tokens.admin).expect(403);
    });

    it('création d’un administrateur → 403', async () => {
      await api(app)
        .post(
          '/administrators',
          {
            firstName: 'Pirate',
            lastName: 'Admin',
            email: `e2e.rbac.pirate.${suffix}@test.gn`,
            phone: `+2246987${suffix}`,
          },
          tokens.admin,
        )
        .expect(403);
    });

    it('journal d’audit → 403 (permission non accordée par défaut)', async () => {
      await api(app).get('/audit-logs', tokens.admin).expect(403);
    });

    it('paramètres système → 403', async () => {
      await api(app).get('/settings/system', tokens.admin).expect(403);
    });

    it('mais accède bien à son périmètre opérationnel', async () => {
      await api(app).get('/orders', tokens.admin).expect(200);
      await api(app).get('/customers', tokens.admin).expect(200);
      await api(app).get('/drivers', tokens.admin).expect(200);
      await api(app).get('/dashboard', tokens.admin).expect(200);
      await api(app).get('/settings/restaurant', tokens.admin).expect(200);
    });
  });

  describe('le SUPER_ADMIN a l’accès global', () => {
    it.each([
      '/administrators',
      '/audit-logs',
      '/settings/system',
      '/dashboard/super-admin',
      '/super-admin/dashboard',
      '/customers',
      '/drivers',
      '/orders',
    ])('%s → 200', async (path) => {
      await api(app).get(path, tokens.superAdmin).expect(200);
    });
  });

  describe('isolation des données entre utilisateurs', () => {
    it('un client ne lit pas la commande d’un autre client', async () => {
      const restaurant = await prisma.restaurant.findFirst();
      const menuItem = await prisma.menuItem.findFirst({ where: { deletedAt: null } });

      if (!restaurant || !menuItem) {
        throw new Error('Base non semée : exécutez `npm run seed` avant les tests e2e.');
      }

      const order = await prisma.order.create({
        data: {
          reference: `E2E-RBAC-${suffix}`,
          customerId: ids.customerB,
          restaurantId: restaurant.id,
          type: 'PICKUP',
          status: 'PENDING',
          subtotal: menuItem.price,
          deliveryFee: 0,
          discount: 0,
          total: menuItem.price,
          paymentMethod: 'CASH_ON_DELIVERY',
          items: {
            create: {
              menuItemId: menuItem.id,
              name: menuItem.name,
              unitPrice: menuItem.price,
              quantity: 1,
              lineTotal: menuItem.price,
            },
          },
        },
      });

      // Le client A n'a rien à voir avec cette commande.
      await api(app).get(`/orders/${order.id}`, tokens.customerA).expect(403);
      // Son propriétaire, lui, la lit.
      await api(app).get(`/orders/${order.id}`, tokens.customerB).expect(200);
      // Le back-office aussi.
      await api(app).get(`/orders/${order.id}`, tokens.admin).expect(200);

      await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
    });

    it('un livreur ne lit pas la course d’un autre livreur', async () => {
      const restaurant = await prisma.restaurant.findFirst();
      if (!restaurant) throw new Error('Base non semée.');

      const order = await prisma.order.create({
        data: {
          reference: `E2E-RBAC-D-${suffix}`,
          customerId: ids.customerA,
          restaurantId: restaurant.id,
          type: 'DELIVERY',
          status: 'ASSIGNED',
          subtotal: 100000,
          deliveryFee: 15000,
          discount: 0,
          total: 115000,
          paymentMethod: 'CASH_ON_DELIVERY',
        },
      });

      const delivery = await prisma.delivery.create({
        data: { orderId: order.id, driverId: ids.driverB, status: 'ASSIGNED', assignedAt: new Date() },
      });

      // Le livreur A n'est pas assigné : accès refusé.
      await api(app).get(`/driver/deliveries/${delivery.id}`, tokens.driverA).expect(403);
      // Le livreur B, lui, voit sa course.
      await api(app).get(`/driver/deliveries/${delivery.id}`, tokens.driverB).expect(200);

      await prisma.deliveryEvent.deleteMany({ where: { deliveryId: delivery.id } });
      await prisma.delivery.delete({ where: { id: delivery.id } });
      await prisma.order.delete({ where: { id: order.id } });
    });

    it('un client ne modifie pas l’adresse d’un autre client', async () => {
      const created = await api(app)
        .post('/addresses', { street: 'Rue du test', district: 'Kaloum' }, tokens.customerB)
        .expect(201);

      const addressId = created.body.data.id as string;

      await api(app).get(`/addresses/${addressId}`, tokens.customerA).expect(404);
      await api(app)
        .patch(`/addresses/${addressId}`, { street: 'Piraté' }, tokens.customerA)
        .expect(404);

      await api(app).get(`/addresses/${addressId}`, tokens.customerB).expect(200);
    });
  });

  describe('permissions individuelles', () => {
    it('un ADMIN privé d’une permission perd immédiatement l’accès correspondant', async () => {
      // Le SUPER_ADMIN redéfinit les permissions de l'ADMIN via l'API :
      // c'est ce chemin qui invalide le cache de permissions.
      const restricted = ['MENU_READ', 'CUSTOMERS_READ'];

      await api(app)
        .patch(`/administrators/${ids.admin}/permissions`, { permissions: restricted }, tokens.superAdmin)
        .expect(200);

      // Le jeton existant reste valide, mais les permissions sont relues
      // en base à chaque requête : l'accès tombe sans reconnexion.
      await api(app).get('/orders', tokens.admin).expect(403);
      await api(app).get('/customers', tokens.admin).expect(200);

      // Restauration du socle du rôle.
      const socle = [
        'CUSTOMERS_READ',
        'CUSTOMERS_UPDATE',
        'CUSTOMERS_SUSPEND',
        'CUSTOMERS_EXPORT',
        'DRIVERS_READ',
        'DRIVERS_CREATE',
        'DRIVERS_UPDATE',
        'DRIVERS_SUSPEND',
        'MENU_READ',
        'MENU_CREATE',
        'MENU_UPDATE',
        'MENU_DELETE',
        'MENU_AVAILABILITY',
        'CATEGORIES_MANAGE',
        'ORDERS_READ',
        'ORDERS_UPDATE_STATUS',
        'ORDERS_ASSIGN_DRIVER',
        'ORDERS_CANCEL',
        'ORDERS_EXPORT',
        'PAYMENTS_READ',
        'PAYMENTS_REFUND',
        'PAYMENTS_EXPORT',
        'DELIVERIES_READ',
        'DELIVERIES_UPDATE',
        'DELIVERIES_TRACK',
        'PROMOTIONS_READ',
        'PROMOTIONS_CREATE',
        'PROMOTIONS_UPDATE',
        'PROMOTIONS_DELETE',
        'REPORTS_READ',
        'REPORTS_EXPORT',
        'SETTINGS_READ',
        'SETTINGS_UPDATE',
      ];

      await api(app)
        .patch(`/administrators/${ids.admin}/permissions`, { permissions: socle }, tokens.superAdmin)
        .expect(200);

      await api(app).get('/orders', tokens.admin).expect(200);
    });

    it('refuse de déléguer une permission réservée au SUPER_ADMIN', async () => {
      const response = await api(app)
        .patch(
          `/administrators/${ids.admin}/permissions`,
          { permissions: ['ORDERS_READ', 'USERS_PERMISSIONS'] },
          tokens.superAdmin,
        )
        .expect(403);

      expect(response.body.code).toBe('PERMISSION_NOT_DELEGABLE');
    });
  });
});
