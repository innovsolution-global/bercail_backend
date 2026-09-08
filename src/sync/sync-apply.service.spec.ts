import { SyncNode, SyncOperation } from '@prisma/client';
import { SyncApplyService } from './sync-apply.service';
import type { SyncChange } from './sync.contract';

/**
 * La synchronisation touche à l'argent : une vente rejouée deux fois, c'est
 * du chiffre d'affaires inventé. Ces tests décrivent les trois garanties
 * qui l'empêchent — l'idempotence, la règle de propriété, et le refus
 * d'écraser une version plus récente.
 */
describe('SyncApplyService', () => {
  function change(overrides: Partial<SyncChange> = {}): SyncChange {
    return {
      id: 'chg-1',
      origin: SyncNode.LOCAL,
      entity: 'Expense',
      entityId: 'exp-1',
      operation: SyncOperation.CREATE,
      payload: { id: 'exp-1', label: 'Facture EDG', amount: 450000 },
      occurredAt: '2026-09-08T10:00:00.000Z',
      ...overrides,
    };
  }

  /**
   * Base simulée : on retient ce qui a été écrit pour pouvoir l'inspecter,
   * comme le ferait Prisma.
   */
  function buildService(
    options: {
      applied?: string[];
      existing?: Record<string, unknown>;
      /** État de la commande et dernier événement de son historique. */
      order?: { status: string };
      latestHistory?: { status: string };
    } = {},
  ) {
    const upserts: Record<string, unknown>[] = [];
    const conflicts: Record<string, unknown>[] = [];
    const orderUpdates: Record<string, unknown>[] = [];
    const appliedIds = new Set(options.applied ?? []);
    const guards: string[] = [];

    const delegate = {
      findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
      upsert: jest.fn().mockImplementation((args: Record<string, unknown>) => {
        upserts.push(args);
        return Promise.resolve({});
      }),
      deleteMany: jest.fn().mockResolvedValue({}),
    };

    const orderDelegate = {
      ...delegate,
      update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        orderUpdates.push(args.data);
        return Promise.resolve({});
      }),
    };

    const tx = {
      $executeRawUnsafe: jest.fn().mockImplementation((sql: string) => {
        guards.push(sql);
        return Promise.resolve(0);
      }),
      expense: delegate,
      order: orderDelegate,
      orderStatusHistory: delegate,
      syncApplied: { create: jest.fn().mockResolvedValue({}) },
    };

    const prisma = {
      transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
      syncApplied: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(appliedIds.has(where.id) ? { id: where.id } : null),
        ),
      },
      syncConflict: {
        create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          conflicts.push(args.data);
          return Promise.resolve({});
        }),
      },
      expense: delegate,
      order: {
        ...orderDelegate,
        // Deux lectures passent par ici : celle qui cherche la version
        // existante avant d'écrire, et celle du recalcul de statut. Les
        // tests n'en exercent qu'une à la fois.
        findUnique: jest.fn().mockResolvedValue(options.existing ?? options.order ?? null),
      },
      orderStatusHistory: {
        ...delegate,
        findFirst: jest.fn().mockResolvedValue(options.latestHistory ?? null),
      },
    };

    const service = new SyncApplyService(prisma as never);
    return { service, upserts, conflicts, guards, delegate, orderUpdates };
  }

  describe('idempotence', () => {
    it('accepte une écriture déjà appliquée sans la réécrire', async () => {
      const { service, upserts } = buildService({ applied: ['chg-1'] });

      const result = await service.apply([change()], SyncNode.CLOUD);

      // Elle est comptée comme acceptée — sinon l'émetteur la renverrait
      // indéfiniment — mais rien n'est réécrit.
      expect(result.accepted).toEqual(['chg-1']);
      expect(upserts).toHaveLength(0);
    });

    it('écrit une écriture inconnue et en garde la trace', async () => {
      const { service, upserts } = buildService();

      const result = await service.apply([change()], SyncNode.CLOUD);

      expect(result.accepted).toEqual(['chg-1']);
      expect(upserts).toHaveLength(1);
      expect((upserts[0].where as { id: string }).id).toBe('exp-1');
    });

    it('marque la transaction pour que l’écriture ne reparte pas vers le pair', async () => {
      const { service, guards } = buildService();

      await service.apply([change()], SyncNode.CLOUD);

      // Sans ce réglage, le déclencheur journaliserait l'écriture et les
      // deux serveurs se la renverraient sans fin.
      expect(guards.some((sql) => sql.includes("app.sync_apply = 'on'"))).toBe(true);
    });
  });

  describe('règle de propriété', () => {
    it('refuse une entité dont ce nœud est propriétaire', async () => {
      const { service, upserts, conflicts } = buildService();

      // Le nœud local reçoit une dépense — or les dépenses se saisissent
      // sur place : le pair n'avait pas à l'écrire.
      const result = await service.apply([change()], SyncNode.LOCAL);

      expect(result.accepted).toHaveLength(0);
      expect(result.conflicted[0].reason).toContain('appartient au nœud LOCAL');
      expect(upserts).toHaveLength(0);
      expect(conflicts).toHaveLength(1);
    });

    it('accepte sans discuter ce qui vient du propriétaire', async () => {
      const { service, upserts } = buildService({
        existing: { id: 'exp-1', updatedAt: new Date('2026-09-09T00:00:00.000Z') },
      });

      // Même avec une version locale plus récente : sur une entité à
      // propriétaire unique, c'est le propriétaire qui fait foi.
      const result = await service.apply([change()], SyncNode.CLOUD);

      expect(result.accepted).toEqual(['chg-1']);
      expect(upserts).toHaveLength(1);
    });
  });

  describe('entités partagées', () => {
    const shared = change({ entity: 'Order', entityId: 'ord-1', payload: { id: 'ord-1' } });

    it('n’écrase pas une version plus récente', async () => {
      const { service, upserts, conflicts } = buildService({
        existing: { id: 'ord-1', updatedAt: new Date('2026-09-08T12:00:00.000Z') },
      });

      // L'écriture entrante date de 10 h, la nôtre de midi.
      const result = await service.apply([shared], SyncNode.CLOUD);

      expect(result.accepted).toHaveLength(0);
      expect(result.conflicted[0].reason).toContain('plus récente');
      expect(upserts).toHaveLength(0);
      // Le conflit est conservé : sur de l'argent, une alerte vaut mieux
      // qu'un écrasement discret.
      expect(conflicts[0].entity).toBe('Order');
    });

    it('applique quand la version locale est plus ancienne', async () => {
      const { service, upserts } = buildService({
        existing: { id: 'ord-1', updatedAt: new Date('2026-09-08T08:00:00.000Z') },
      });

      const result = await service.apply([shared], SyncNode.CLOUD);

      expect(result.accepted).toEqual(['chg-1']);
      expect(upserts).toHaveLength(1);
    });

    it('accepte toujours une ligne d’historique, écrite en ajout seul', async () => {
      const { service, upserts } = buildService({
        existing: { id: 'hist-1', createdAt: new Date('2026-09-09T00:00:00.000Z') },
      });

      const history = change({
        entity: 'OrderStatusHistory',
        entityId: 'hist-1',
        payload: { id: 'hist-1', orderId: 'ord-1', status: 'PREPARING' },
      });

      // L'historique ne se contredit jamais : la cuisine peut faire avancer
      // une commande passée en ligne sans rien écraser.
      const result = await service.apply([history], SyncNode.CLOUD);

      expect(result.accepted).toEqual(['chg-1']);
      expect(upserts).toHaveLength(1);
    });
  });

  describe('statut d’une commande', () => {
    const history = change({
      entity: 'OrderStatusHistory',
      entityId: 'hist-1',
      payload: { id: 'hist-1', orderId: 'ord-1', status: 'PREPARING' },
    });

    it('déduit le statut du dernier événement reçu', async () => {
      const { service, orderUpdates } = buildService({
        order: { status: 'CONFIRMED' },
        latestHistory: { status: 'PREPARING' },
      });

      await service.apply([history], SyncNode.CLOUD);

      // Le statut n'est pas répliqué mais recalculé : une commande ne peut
      // pas reculer parce qu'un lot est arrivé dans le désordre.
      expect(orderUpdates).toEqual([{ status: 'PREPARING' }]);
    });

    it('ne touche pas à la commande si le statut est déjà le bon', async () => {
      const { service, orderUpdates } = buildService({
        order: { status: 'PREPARING' },
        latestHistory: { status: 'PREPARING' },
      });

      await service.apply([history], SyncNode.CLOUD);

      expect(orderUpdates).toHaveLength(0);
    });
  });

  describe('robustesse', () => {
    it('écarte une entité hors périmètre au lieu de l’écrire', async () => {
      const { service, upserts } = buildService();

      const result = await service.apply(
        [change({ entity: 'RefreshToken', entityId: 'tok-1' })],
        SyncNode.CLOUD,
      );

      expect(result.accepted).toHaveLength(0);
      expect(result.conflicted[0].reason).toContain('hors du périmètre');
      expect(upserts).toHaveLength(0);
    });

    it('poursuit le lot quand une écriture échoue', async () => {
      const { service, delegate } = buildService();
      delegate.upsert
        .mockRejectedValueOnce(new Error('contrainte violée'))
        .mockResolvedValue({});

      const result = await service.apply(
        [change({ id: 'chg-1', entityId: 'exp-1' }), change({ id: 'chg-2', entityId: 'exp-2' })],
        SyncNode.CLOUD,
      );

      // Après une coupure, un lot rattrape des heures de service : une
      // ligne fautive ne doit pas emporter les quarante autres.
      expect(result.conflicted).toHaveLength(1);
      expect(result.accepted).toEqual(['chg-2']);
    });

    it('convertit les dates ISO reçues en objets Date', async () => {
      const { service, upserts } = buildService();

      await service.apply(
        [change({ payload: { id: 'exp-1', incurredAt: '2026-09-08T10:00:00.000Z' } })],
        SyncNode.CLOUD,
      );

      // Prisma refuse une chaîne là où il attend une date.
      const data = upserts[0].create as { incurredAt: unknown };
      expect(data.incurredAt).toBeInstanceOf(Date);
    });
  });
});
