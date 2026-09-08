import { INestApplication } from '@nestjs/common';
import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { api, cleanupUsers, createTestApp, login, seedUser } from './helpers/app.helper';

/**
 * Authentification — scénarios de bout en bout.
 *
 * Ils vérifient les règles structurantes du contrat : l'inscription
 * publique ne crée que des clients, les jetons tournent, un compte
 * suspendu perd l'accès immédiatement.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const suffix = Date.now().toString().slice(-6);

  const customer = {
    firstName: 'Test',
    lastName: 'Client',
    email: `e2e.client.${suffix}@test.gn`,
    phone: `+2246999${suffix}`,
    password: 'Bercail@2024',
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanupUsers(prisma, 'e2e.');
    await prisma.$disconnect();
    await app.close();
  });

  describe('inscription publique', () => {
    it('crée un compte CUSTOMER et renvoie une session complète', async () => {
      const response = await api(app).post('/auth/register', customer).expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.refreshToken).toEqual(expect.any(String));
      expect(response.body.data.user.role).toBe(Role.CUSTOMER);
      expect(response.body.data.user.email).toBe(customer.email);
      // Aucun secret ne doit sortir.
      expect(response.body.data.user.passwordHash).toBeUndefined();
    });

    it('refuse un rôle imposé par le client', async () => {
      const response = await api(app)
        .post('/auth/register', {
          ...customer,
          email: `e2e.pirate.${suffix}@test.gn`,
          phone: `+2246998${suffix}`,
          role: 'SUPER_ADMIN',
        })
        .expect(422);

      // `forbidNonWhitelisted` rejette le champ inconnu : il n'atteint
      // même pas la logique métier.
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuse un e-mail déjà utilisé', async () => {
      const response = await api(app)
        .post('/auth/register', { ...customer, phone: `+2246997${suffix}` })
        .expect(409);

      expect(response.body.code).toBe('CONFLICT');
    });

    it('refuse un mot de passe trop faible', async () => {
      const response = await api(app)
        .post('/auth/register', {
          ...customer,
          email: `e2e.faible.${suffix}@test.gn`,
          phone: `+2246996${suffix}`,
          password: 'motdepasse',
        })
        .expect(422);

      expect(response.body.message).toMatch(/mot de passe/i);
    });
  });

  describe('connexion', () => {
    it('accepte l’e-mail', async () => {
      const session = await login(app, customer.email, customer.password);
      expect(session.user.role).toBe(Role.CUSTOMER);
    });

    it('accepte aussi le numéro de téléphone', async () => {
      const response = await api(app)
        .post('/auth/login', { email: customer.phone, password: customer.password })
        .expect(200);

      expect(response.body.data.user.email).toBe(customer.email);
    });

    it('renvoie le même message pour un compte inconnu et un mot de passe erroné', async () => {
      const unknown = await api(app)
        .post('/auth/login', { email: `absent.${suffix}@test.gn`, password: 'Bercail@2024' })
        .expect(401);

      const wrong = await api(app)
        .post('/auth/login', { email: customer.email, password: 'Mauvais@2024' })
        .expect(401);

      // Aucun des deux ne révèle si l'adresse existe.
      expect(unknown.body.message).toBe(wrong.body.message);
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('session', () => {
    it('renvoie le profil du porteur du jeton', async () => {
      const session = await login(app, customer.email, customer.password);
      const response = await api(app).get('/auth/me', session.accessToken).expect(200);

      expect(response.body.data.email).toBe(customer.email);
      expect(response.body.data.permissions).toEqual([]);
    });

    it('refuse un accès sans jeton', async () => {
      const response = await api(app).get('/auth/me').expect(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('fait tourner le refresh token et invalide l’ancien', async () => {
      const session = await login(app, customer.email, customer.password);

      const refreshed = await api(app)
        .post('/auth/refresh', { refreshToken: session.refreshToken })
        .expect(200);

      expect(refreshed.body.data.refreshToken).not.toBe(session.refreshToken);

      // Rejouer l'ancien jeton ferme toutes les sessions : c'est le
      // scénario du jeton volé.
      const replayed = await api(app)
        .post('/auth/refresh', { refreshToken: session.refreshToken })
        .expect(401);

      expect(replayed.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('ferme la session à la déconnexion', async () => {
      const session = await login(app, customer.email, customer.password);

      await api(app)
        .post('/auth/logout', { refreshToken: session.refreshToken }, session.accessToken)
        .expect(200);

      await api(app).post('/auth/refresh', { refreshToken: session.refreshToken }).expect(401);
    });
  });

  describe('profil personnel', () => {
    it('permet à chaque rôle de corriger son propre profil', async () => {
      const session = await login(app, customer.email, customer.password);

      const updated = await api(app)
        .patch('/auth/me', { firstName: 'Mariama-Test', phone: `+2246977${suffix}` }, session.accessToken)
        .expect(200);

      expect(updated.body.data.firstName).toBe('Mariama-Test');
      expect(updated.body.data.phone).toBe(`+2246977${suffix}`);
      // Ce qui ne doit pas bouger.
      expect(updated.body.data.email).toBe(customer.email);
      expect(updated.body.data.role).toBe(Role.CUSTOMER);
    });

    it("refuse de changer l'e-mail, le rôle ou les permissions", async () => {
      const session = await login(app, customer.email, customer.password);

      for (const payload of [
        { email: `pirate.${suffix}@test.gn` },
        { role: 'SUPER_ADMIN' },
        { permissions: ['USERS_READ'] },
        { status: 'active' },
      ]) {
        const response = await api(app).patch('/auth/me', payload, session.accessToken).expect(422);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('refuse un numéro déjà utilisé par un autre compte', async () => {
      const autre = await seedUser(prisma, {
        role: Role.CUSTOMER,
        email: `e2e.profil.${suffix}@test.gn`,
        phone: `+2246978${suffix}`,
        password: 'Bercail@2024',
      });

      const session = await login(app, customer.email, customer.password);
      const response = await api(app)
        .patch('/auth/me', { phone: autre.phone }, session.accessToken)
        .expect(409);

      expect(response.body.code).toBe('CONFLICT');
    });

    it('exige un jeton', async () => {
      await api(app).patch('/auth/me', { firstName: 'Anonyme' }).expect(401);
    });
  });

  describe('comptes non actifs', () => {
    it('refuse la connexion d’un compte suspendu', async () => {
      const suspended = await seedUser(prisma, {
        role: Role.CUSTOMER,
        email: `e2e.suspendu.${suffix}@test.gn`,
        phone: `+2246995${suffix}`,
        password: 'Bercail@2024',
        status: AccountStatus.SUSPENDED,
      });

      const response = await api(app)
        .post('/auth/login', { email: suspended.email, password: 'Bercail@2024' })
        .expect(403);

      expect(response.body.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('refuse la connexion d’un compte en attente d’activation', async () => {
      const pending = await seedUser(prisma, {
        role: Role.ADMIN,
        email: `e2e.pending.${suffix}@test.gn`,
        phone: `+2246994${suffix}`,
        password: 'Bercail@2024',
        status: AccountStatus.PENDING,
      });

      const response = await api(app)
        .post('/auth/login', { email: pending.email, password: 'Bercail@2024' })
        .expect(403);

      expect(response.body.code).toBe('ACCOUNT_PENDING');
    });
  });

  describe('mot de passe', () => {
    it('renvoie toujours le même message à « mot de passe oublié »', async () => {
      const known = await api(app)
        .post('/auth/forgot-password', { email: customer.email })
        .expect(200);

      const unknown = await api(app)
        .post('/auth/forgot-password', { email: `jamais.vu.${suffix}@test.gn` })
        .expect(200);

      expect(known.body.data.sent).toBe(true);
      expect(unknown.body.data.sent).toBe(true);
    });

    it('permet de réinitialiser puis de se reconnecter', async () => {
      const request = await api(app)
        .post('/auth/forgot-password', { email: customer.email })
        .expect(200);

      // Hors production, le jeton est renvoyé pour rendre le scénario testable.
      const token = request.body.data.resetToken as string;
      expect(token).toEqual(expect.any(String));

      await api(app)
        .post('/auth/reset-password', { token, password: 'Nouveau@2024' })
        .expect(200);

      await api(app)
        .post('/auth/login', { email: customer.email, password: customer.password })
        .expect(401);

      const session = await login(app, customer.email, 'Nouveau@2024');
      expect(session.accessToken).toEqual(expect.any(String));

      // On remet le mot de passe d'origine pour les suites suivantes.
      await api(app)
        .post(
          '/auth/change-password',
          { currentPassword: 'Nouveau@2024', newPassword: customer.password },
          session.accessToken,
        )
        .expect(200);
    });
  });
});
