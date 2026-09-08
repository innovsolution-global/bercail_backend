import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { api, cleanupUsers, createTestApp, login, seedUser } from './helpers/app.helper';

/**
 * Scénario complet — §80 du contrat.
 *
 * Un seul récit, joué par quatre acteurs sur la même API :
 * le client commande et paie, le gestionnaire fait avancer la commande et
 * attribue un livreur, le livreur récupère puis livre avec le code du
 * client. Chaque étape vérifie aussi ce qui doit être **refusé**.
 */
describe('Parcours de commande (e2e)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const suffix = Date.now().toString().slice(-6);
  const password = 'Bercail@2024';

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();

    const customer = await seedUser(prisma, {
      role: Role.CUSTOMER,
      email: `e2e.flow.client.${suffix}@test.gn`,
      phone: `+2246971${suffix}`,
      password,
    });
    const driver = await seedUser(prisma, {
      role: Role.DRIVER,
      email: `e2e.flow.livreur.${suffix}@test.gn`,
      phone: `+2246972${suffix}`,
      password,
      driverCode: `LIV-F${suffix.slice(-3)}`,
    });
    const admin = await seedUser(prisma, {
      role: Role.SUPER_ADMIN,
      email: `e2e.flow.admin.${suffix}@test.gn`,
      phone: `+2246973${suffix}`,
      password,
    });

    ids.customer = customer.id;
    ids.driverProfile = driver.driverProfile!.id;
    ids.admin = admin.id;

    tokens.customer = (await login(app, customer.email, password)).accessToken;
    tokens.driver = (await login(app, driver.email, password)).accessToken;
    tokens.admin = (await login(app, admin.email, password)).accessToken;
  });

  afterAll(async () => {
    await cleanupUsers(prisma, 'e2e.flow.');
    await prisma.$disconnect();
    await app.close();
  });

  /**
   * Un plat principal de la carte, avec le choix obligatoire déjà résolu.
   *
   * Tous les plats du restaurant imposent un accompagnement : un test qui
   * chercherait un plat « sans option » ne trouverait rien, et surtout il
   * n'exercerait pas le calcul des suppléments.
   */
  async function plat(): Promise<{ menuItemId: string; optionIds: string[]; price: number }> {
    const menu = await api(app).get('/menu-items?limit=100', tokens.customer).expect(200);

    const item = (menu.body.data as Record<string, unknown>[]).find(
      (candidate) =>
        (candidate.optionGroups as { isRequired: boolean }[]).some((group) => group.isRequired) &&
        (candidate.price as number) >= 50000,
    );

    if (!item) throw new Error('Base non semée : exécutez `npm run seed` avant les tests e2e.');

    const groups = item.optionGroups as {
      isRequired: boolean;
      options: { id: string; extraPrice: number }[];
    }[];

    return {
      menuItemId: item.id as string,
      // Un choix par groupe obligatoire, en privilégiant une option payante.
      optionIds: groups
        .filter((group) => group.isRequired)
        .map((group) => (group.options.find((o) => o.extraPrice > 0) ?? group.options[0]).id),
      price: item.price as number,
    };
  }

  it('déroule le parcours complet, de la carte à la livraison confirmée', async () => {
    /* ── 1. Le client consulte la carte ──────────────────────────────────── */

    const menu = await api(app).get('/menu-items?limit=100', tokens.customer).expect(200);
    expect(menu.body.data.length).toBeGreaterThan(0);
    expect(menu.body.meta.total).toBeGreaterThan(0);

    const choix = await plat();

    /* ── 2. Il remplit son panier ────────────────────────────────────────── */

    // Sans le choix obligatoire, le serveur refuse.
    const incomplet = await api(app)
      .post('/cart/items', { menuItemId: choix.menuItemId, quantity: 1 }, tokens.customer)
      .expect(400);
    expect(incomplet.body.code).toBe('OPTION_GROUP_REQUIRED');

    const cart = await api(app)
      .post(
        '/cart/items',
        { menuItemId: choix.menuItemId, quantity: 2, optionIds: choix.optionIds },
        tokens.customer,
      )
      .expect(201);

    expect(cart.body.data.itemsCount).toBe(2);
    // Le serveur a calculé le prix, suppléments compris : le client n'a
    // envoyé aucun montant.
    expect(cart.body.data.subtotal).toBeGreaterThanOrEqual(choix.price * 2);
    expect(cart.body.data.items[0].options.length).toBe(choix.optionIds.length);

    /* ── 3. Il enregistre une adresse ────────────────────────────────────── */

    const address = await api(app)
      .post(
        '/addresses',
        {
          label: 'Domicile',
          street: 'Rue du test 42',
          district: 'Kaloum',
          latitude: 9.51,
          longitude: -13.71,
        },
        tokens.customer,
      )
      .expect(201);

    expect(address.body.data.isDefault).toBe(true);

    /* ── 4. Il demande un devis, puis commande ───────────────────────────── */

    const quote = await api(app)
      .post('/orders/quote', { type: 'delivery' }, tokens.customer)
      .expect(200);

    const order = await api(app)
      .post(
        '/orders',
        {
          type: 'delivery',
          addressId: address.body.data.id,
          paymentMethod: 'cash_on_delivery',
          note: 'Test automatisé',
        },
        tokens.customer,
      )
      .expect(201);

    ids.order = order.body.data.id;

    // Le total facturé est exactement celui du devis.
    expect(order.body.data.total).toBe(quote.body.data.total);
    expect(order.body.data.status).toBe('pending');
    expect(order.body.data.paymentStatus).toBe('pending');

    // Le panier est vidé.
    const emptyCart = await api(app).get('/cart', tokens.customer).expect(200);
    expect(emptyCart.body.data.items).toEqual([]);

    /* ── 5. Le gestionnaire fait avancer la commande ─────────────────────── */

    for (const status of ['confirmed', 'preparing', 'ready']) {
      const response = await api(app)
        .patch(`/orders/${ids.order}/status`, { status }, tokens.admin)
        .expect(200);
      expect(response.body.data.status).toBe(status);
    }

    // Une transition impossible est refusée, même pour un SUPER_ADMIN.
    const invalid = await api(app)
      .patch(`/orders/${ids.order}/status`, { status: 'pending' }, tokens.admin)
      .expect(409);
    expect(invalid.body.code).toBe('INVALID_STATUS_TRANSITION');

    /* ── 6. Il attribue la course à un livreur ───────────────────────────── */

    const assignable = await api(app)
      .get(`/drivers/assignable?orderId=${ids.order}`, tokens.admin)
      .expect(200);
    expect(assignable.body.data.some((driver: { id: string }) => driver.id === ids.driverProfile)).toBe(
      true,
    );

    const assigned = await api(app)
      .post(`/orders/${ids.order}/assign`, { driverId: ids.driverProfile }, tokens.admin)
      .expect(200);

    expect(assigned.body.data.status).toBe('assigned');

    /* ── 7. Le client reçoit son code de confirmation ────────────────────── */

    const notifications = await api(app).get('/notifications', tokens.customer).expect(200);
    const codeNotification = (notifications.body.data as { title: string; body: string }[]).find(
      (notification) => notification.body.includes('code de confirmation'),
    );
    expect(codeNotification).toBeDefined();

    const code = codeNotification!.body.match(/([0-9]{4,8})/)?.[1];
    expect(code).toBeDefined();

    /* ── 8. Le livreur prend sa course ───────────────────────────────────── */

    const runs = await api(app).get('/driver/deliveries?scope=active', tokens.driver).expect(200);
    expect(runs.body.data).toHaveLength(1);

    const deliveryId = runs.body.data[0].id as string;
    ids.delivery = deliveryId;

    // Il ne voit que ce dont il a besoin : pas d'e-mail client.
    expect(runs.body.data[0].customer.phone).toEqual(expect.any(String));
    expect(runs.body.data[0].customer.email).toBeUndefined();

    await api(app).post(`/driver/deliveries/${deliveryId}/accept`, {}, tokens.driver).expect(200);
    await api(app)
      .post(`/driver/deliveries/${deliveryId}/arrived-restaurant`, {}, tokens.driver)
      .expect(200);

    const pickedUp = await api(app)
      .post(`/driver/deliveries/${deliveryId}/pickup`, {}, tokens.driver)
      .expect(200);
    expect(pickedUp.body.data.status).toBe('picked_up');

    // La commande a suivi : elle est passée « en livraison ».
    const inDelivery = await api(app).get(`/orders/${ids.order}`, tokens.admin).expect(200);
    expect(inDelivery.body.data.status).toBe('out_for_delivery');

    /* ── 9. Il transmet sa position ──────────────────────────────────────── */

    await api(app)
      .post(
        '/driver/location',
        { latitude: 9.512, longitude: -13.708, accuracy: 8, speed: 9, deliveryId },
        tokens.driver,
      )
      .expect(200);

    // Le client suit sa livraison ; un autre client n'y aurait pas accès.
    const tracking = await api(app)
      .get(`/orders/${ids.order}/tracking`, tokens.customer)
      .expect(200);
    expect(tracking.body.data.delivery.driver.position.latitude).toBeCloseTo(9.512, 3);

    /* ── 10. Remise avec le code du client ───────────────────────────────── */

    await api(app).post(`/driver/deliveries/${deliveryId}/start`, {}, tokens.driver).expect(200);
    await api(app).post(`/driver/deliveries/${deliveryId}/arrived`, {}, tokens.driver).expect(200);

    // Mauvais code : refusé, et la course n'avance pas.
    const wrongCode = await api(app)
      .post(`/driver/deliveries/${deliveryId}/complete`, { code: '0000' }, tokens.driver)
      .expect(400);
    expect(wrongCode.body.code).toBe('OTP_INVALID');

    const completed = await api(app)
      .post(`/driver/deliveries/${deliveryId}/complete`, { code }, tokens.driver)
      .expect(200);
    expect(completed.body.data.status).toBe('delivered');

    /* ── 11. La commande est livrée et payée ─────────────────────────────── */

    const finalOrder = await api(app).get(`/orders/${ids.order}`, tokens.customer).expect(200);
    expect(finalOrder.body.data.status).toBe('delivered');
    // Paiement à la livraison : encaissé à la remise.
    expect(finalOrder.body.data.paymentStatus).toBe('paid');
    expect(finalOrder.body.data.deliveredAt).toEqual(expect.any(String));

    // Le code ne peut pas resservir.
    const replay = await api(app)
      .post(`/driver/deliveries/${deliveryId}/complete`, { code }, tokens.driver)
      .expect(409);
    expect(replay.body.code).toBe('INVALID_DELIVERY_TRANSITION');

    /* ── 12. L'historique du client est à jour ───────────────────────────── */

    const history = await api(app).get('/orders?scope=past', tokens.customer).expect(200);
    expect(history.body.data.some((entry: { id: string }) => entry.id === ids.order)).toBe(true);
  });

  describe('règles de prix et de commande', () => {
    it('refuse un montant envoyé par le client', async () => {
      const response = await api(app)
        .post(
          '/orders',
          {
            type: 'pickup',
            paymentMethod: 'cash_on_delivery',
            total: 1,
            subtotal: 1,
          },
          tokens.customer,
        )
        .expect(422);

      // Les champs de montant ne font pas partie du contrat d'entrée.
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuse une commande avec un panier vide', async () => {
      const response = await api(app)
        .post('/orders', { type: 'pickup', paymentMethod: 'cash_on_delivery' }, tokens.customer)
        .expect(400);

      expect(response.body.code).toBe('CART_EMPTY');
    });

    it('rejoue la même réponse pour une clé d’idempotence identique', async () => {
      const choix = await plat();

      await api(app)
        .post(
          '/cart/items',
          { menuItemId: choix.menuItemId, quantity: 1, optionIds: choix.optionIds },
          tokens.customer,
        )
        .expect(201);

      const key = `e2e-idem-${suffix}`;
      const body = { type: 'pickup', paymentMethod: 'cash_on_delivery' };

      const first = await api(app)
        .post('/orders', body, tokens.customer)
        .set('Idempotency-Key', key)
        .expect(201);

      const second = await api(app)
        .post('/orders', body, tokens.customer)
        .set('Idempotency-Key', key)
        .expect(201);

      // Une seule commande a réellement été créée.
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.reference).toBe(first.body.data.reference);
    });

    it('laisse le client annuler tant que la cuisine n’a pas commencé', async () => {
      const choix = await plat();

      await api(app)
        .post(
          '/cart/items',
          { menuItemId: choix.menuItemId, quantity: 1, optionIds: choix.optionIds },
          tokens.customer,
        )
        .expect(201);

      const order = await api(app)
        .post('/orders', { type: 'pickup', paymentMethod: 'cash_on_delivery' }, tokens.customer)
        .expect(201);

      const cancelled = await api(app)
        .post(`/orders/${order.body.data.id}/cancel`, { reason: 'Changement d’avis' }, tokens.customer)
        .expect(200);

      expect(cancelled.body.data.status).toBe('cancelled');

      // Une fois annulée, plus aucune transition n'est possible.
      await api(app)
        .patch(`/orders/${order.body.data.id}/status`, { status: 'confirmed' }, tokens.admin)
        .expect(409);
    });

    it('empêche le client d’annuler une commande en préparation', async () => {
      const choix = await plat();

      await api(app)
        .post(
          '/cart/items',
          { menuItemId: choix.menuItemId, quantity: 1, optionIds: choix.optionIds },
          tokens.customer,
        )
        .expect(201);

      const order = await api(app)
        .post('/orders', { type: 'pickup', paymentMethod: 'cash_on_delivery' }, tokens.customer)
        .expect(201);

      await api(app)
        .patch(`/orders/${order.body.data.id}/status`, { status: 'confirmed' }, tokens.admin)
        .expect(200);
      await api(app)
        .patch(`/orders/${order.body.data.id}/status`, { status: 'preparing' }, tokens.admin)
        .expect(200);

      const refused = await api(app)
        .post(`/orders/${order.body.data.id}/cancel`, { reason: 'Trop tard' }, tokens.customer)
        .expect(409);

      expect(refused.body.code).toBe('ORDER_NOT_CANCELLABLE');

      // Le back-office, lui, peut encore annuler.
      await api(app)
        .post(`/orders/${order.body.data.id}/cancel`, { reason: 'Rupture de stock' }, tokens.admin)
        .expect(200);
    });
  });
});
