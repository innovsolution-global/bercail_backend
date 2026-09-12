import { ChapChapService } from './chapchap.service';

/**
 * La vérification de signature est la seule barrière du rappel : la route
 * est publique par nécessité, Chap Chap n'ayant pas de compte chez nous.
 * Si elle cède, n'importe qui peut déclarer ses commandes payées.
 *
 * C'est aussi la partie qu'on peut éprouver sans l'API de l'opérateur —
 * le reste dépend de la forme exacte de ses réponses.
 */
describe('ChapChapService — signature des rappels', () => {
  const SECRET = '2ed6d333ab19999f8419f5ced62026eb';

  function build(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      'payment.chapchap.enabled': true,
      'payment.chapchap.webhookSecret': SECRET,
      'payment.chapchap.hmacSecret': SECRET,
      'payment.chapchap.allowUnsigned': false,
      'payment.chapchap.signatureHeader': 'ccp-hmac-signature',
      'payment.chapchap.publicBaseUrl': 'https://ziza-local.loca.lt',
      'payment.chapchap.notifyPath': '/v1/webhooks/chapchap',
      'payment.chapchap.frontendBaseUrl': 'https://ziza-front.loca.lt',
      'payment.chapchap.returnPath': '/paiement/succes',
      'payment.chapchap.cancelPath': '/paiement/echec',
      apiUrl: 'http://localhost:3000',
      ...overrides,
    };

    return new ChapChapService({ get: (key: string) => values[key] } as never);
  }

  /** Signature légitime, calculée comme Chap Chap le ferait. */
  function signature(body: string, secret = SECRET): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }

  const body = '{"reference":"TRX-260909-A1B2","status":"success","amount":145000}';

  it('accepte un rappel correctement signé', () => {
    expect(build().verifyWebhook(body, signature(body))).toBe(true);
  });

  it('refuse un corps modifié après signature', () => {
    const valide = signature(body);
    // Le montant est passé de 145 000 à 1 : la signature ne suit pas.
    const falsifie = body.replace('145000', '1');

    expect(build().verifyWebhook(falsifie, valide)).toBe(false);
  });

  it('refuse une signature calculée avec un autre secret', () => {
    expect(build().verifyWebhook(body, signature(body, 'mauvais-secret'))).toBe(false);
  });

  it('refuse un rappel sans signature', () => {
    expect(build().verifyWebhook(body, undefined)).toBe(false);
  });

  it('accepte un préfixe « sha256= » sur la signature', () => {
    // Certains opérateurs préfixent l'algorithme ; le nôtre ne le fait pas
    // aujourd'hui, mais l'accepter ne coûte rien et évite une panne muette.
    expect(build().verifyWebhook(body, `sha256=${signature(body)}`)).toBe(true);
  });

  it('n’accepte un rappel non signé que si on l’a explicitement autorisé', () => {
    const permissif = build({ 'payment.chapchap.allowUnsigned': true });

    expect(permissif.verifyWebhook(body, undefined)).toBe(true);
    // Même en mode permissif, une signature présente doit être valable :
    // sinon l'option ouvrirait une porte plus large que prévu.
    expect(permissif.verifyWebhook(body, 'signature-inventee')).toBe(false);
  });

  it('signe sur les octets reçus, pas sur l’objet reconstruit', () => {
    const service = build();

    // Un opérateur qui indente son JSON envoie d'autres octets pour le même
    // contenu. C'est le cas qui casse une vérification écrite naïvement sur
    // l'objet analysé plutôt que sur le corps brut.
    const indente = JSON.stringify(JSON.parse(body), null, 2);
    expect(indente).not.toBe(body);

    // La signature de l'opérateur porte sur ce qu'il a réellement envoyé.
    expect(service.verifyWebhook(indente, signature(indente))).toBe(true);
    // Et une signature calculée sur une autre sérialisation ne vaut rien.
    expect(service.verifyWebhook(indente, signature(body))).toBe(false);
  });

  it('compose l’adresse de rappel depuis l’URL publique, pas depuis API_URL', () => {
    // Le piège : `apiUrl` vaut localhost en développement. Bâtir le rappel
    // dessus le rendrait injoignable, et le paiement resterait « en cours »
    // sans que rien ne signale pourquoi.
    expect(build().notifyUrl()).toBe('https://ziza-local.loca.lt/v1/webhooks/chapchap');
  });

  it('compose les pages d’atterrissage sur le site déclaré', () => {
    const service = build();

    expect(service.returnUrl('TRX-260909-A1B2')).toBe(
      'https://ziza-front.loca.lt/paiement/succes?reference=TRX-260909-A1B2',
    );
    expect(service.cancelUrl('TRX-260909-A1B2')).toBe(
      'https://ziza-front.loca.lt/paiement/echec?reference=TRX-260909-A1B2',
    );
  });

  it('n’invente pas d’adresse d’atterrissage faute de site déclaré', () => {
    // Envoyer une adresse construite sur du vide renverrait le client sur
    // une page inexistante ; mieux vaut n'en envoyer aucune et le laisser
    // sur la page de confirmation de l'opérateur.
    const sansSite = build({ 'payment.chapchap.frontendBaseUrl': '' });

    expect(sansSite.returnUrl('TRX-1')).toBeUndefined();
    expect(sansSite.cancelUrl('TRX-1')).toBeUndefined();
  });

  it('ne double pas la barre entre la base et le chemin', () => {
    const avecBarre = build({ 'payment.chapchap.publicBaseUrl': 'https://ziza-local.loca.lt/' });

    expect(avecBarre.notifyUrl()).toBe('https://ziza-local.loca.lt/v1/webhooks/chapchap');
  });

  it('se désactive tant que les clés manquent', () => {
    expect(build({ 'payment.chapchap.enabled': false }).enabled).toBe(false);
  });
});

/**
 * La requête sortante.
 *
 * Chap Chap n'authentifie que l'en-tête `CCP-Api-Key` : envoyée sous un
 * autre nom — `Authorization: Bearer`, `X-API-KEY` — la clé est ignorée
 * et l'opérateur répond « API Key is required ». Le défaut se voit
 * seulement en tapant sur son API, donc jamais en test : d'où ce
 * verrou sur la forme exacte de l'appel.
 */
describe('ChapChapService — requête de création', () => {
  const SECRET = '2ed6d333ab19999f8419f5ced62026eb';
  const KEY = 'a'.repeat(64);

  function service() {
    const values: Record<string, unknown> = {
      'payment.chapchap.enabled': true,
      'payment.chapchap.baseUrl': 'https://chapchappay.com/api',
      'payment.chapchap.ecommercePath': 'ecommerce/create',
      'payment.chapchap.apiKey': KEY,
      'payment.chapchap.hmacSecret': SECRET,
      'payment.chapchap.signatureHeader': 'ccp-hmac-signature',
      'payment.chapchap.bodyStyle': 'snake',
      apiUrl: 'http://localhost:3000',
    };

    return new ChapChapService({ get: (key: string) => values[key] } as never);
  }

  let captured: { url: string; init: RequestInit } | null = null;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    captured = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            operation_id: 'op-1',
            payment_url: 'https://chapchappay.com/pay/op-1/',
          }),
      };
    }) as never;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('porte la clé dans l’en-tête que Chap Chap lit', async () => {
    await service().createOperation({
      reference: 'TRX-1',
      amount: 75000,
      description: 'Commande BRC-1',
      notifyUrl: 'https://exemple.test/v1/webhooks/chapchap',
    });

    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['CCP-Api-Key']).toBe(KEY);

    // Les en-têtes d'authentification usuels ne servent à rien ici : les
    // envoyer donnerait l'illusion d'être authentifié.
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-API-KEY']).toBeUndefined();
  });

  it('appelle le chemin de création, pas celui de lecture', async () => {
    await service().createOperation({
      reference: 'TRX-2',
      amount: 75000,
      description: 'Commande BRC-2',
      notifyUrl: 'https://exemple.test/v1/webhooks/chapchap',
    });

    // `ecommerce/operation` existe mais ne répond qu'en GET : y poster
    // rend un 405.
    expect(captured!.url).toBe('https://chapchappay.com/api/ecommerce/create');
    expect(captured!.init.method).toBe('POST');
  });

  it('retient l’identifiant d’opération et la page de paiement', async () => {
    const operation = await service().createOperation({
      reference: 'TRX-3',
      amount: 75000,
      description: 'Commande BRC-3',
      notifyUrl: 'https://exemple.test/v1/webhooks/chapchap',
    });

    expect(operation.providerRef).toBe('op-1');
    expect(operation.paymentUrl).toBe('https://chapchappay.com/pay/op-1/');
  });
});

/**
 * L'interrogation de l'opérateur.
 *
 * Elle est le filet quand le rappel n'arrive pas — serveur non joignable
 * de l'extérieur, coupure passagère. Deux détails la rendent possible et
 * ne se voient qu'en tapant sur l'API : Chap Chap retrouve une opération
 * par le `order_id` **que nous lui avons donné**, et il répond son état
 * dans un objet `status`, non à plat comme le rappel.
 */
describe('ChapChapService — interrogation de l’opérateur', () => {
  const KEY = 'b'.repeat(64);

  function service() {
    const values: Record<string, unknown> = {
      'payment.chapchap.enabled': true,
      'payment.chapchap.baseUrl': 'https://chapchappay.com/api',
      'payment.chapchap.ecommercePath': 'ecommerce/create',
      'payment.chapchap.apiKey': KEY,
      'payment.chapchap.hmacSecret': 'c'.repeat(32),
      'payment.chapchap.signatureHeader': 'ccp-hmac-signature',
      'payment.chapchap.bodyStyle': 'snake',
      apiUrl: 'http://localhost:3000',
    };

    return new ChapChapService({ get: (key: string) => values[key] } as never);
  }

  let captured: { url: string; init: RequestInit } | null = null;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function answer(status: number, body: unknown) {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    }) as never;
  }

  it('annonce notre référence comme numéro de commande', async () => {
    answer(201, { operation_id: 'op-9', payment_url: 'https://exemple.test/p' });

    await service().createOperation({
      reference: 'TRX-9',
      amount: 35000,
      description: 'Commande BRC-9',
      notifyUrl: 'https://exemple.test/v1/webhooks/chapchap',
    });

    // Sans ce champ, l'opération n'est interrogeable par rien de ce que
    // nous gardons, et le rappel devient le seul moyen de savoir.
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body.order_id).toBe('TRX-9');
  });

  it('interroge l’opération par cette même référence', async () => {
    answer(200, { order_id: 'TRX-9', status: { code: 'success' } });

    const operation = await service().readOperation('TRX-9');

    expect(captured!.url).toBe('https://chapchappay.com/api/ecommerce/order/TRX-9');
    expect((captured!.init.headers as Record<string, string>)['CCP-Api-Key']).toBe(KEY);
    expect(operation).toEqual({ order_id: 'TRX-9', status: { code: 'success' } });
  });

  it('rend null plutôt que de faire échouer une lecture', async () => {
    answer(404, { message: 'Aucune opération trouvée.' });

    // L'appelant garde alors l'état qu'il avait : un opérateur muet ne
    // doit pas défaire un paiement.
    expect(await service().readOperation('TRX-inconnue')).toBeNull();
  });
});
