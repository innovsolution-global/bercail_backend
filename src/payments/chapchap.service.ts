import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

/** Ce que le back-end demande à Chap Chap d'encaisser. */
export interface ChapChapOperationInput {
  /** Notre référence : elle revient telle quelle dans le rappel. */
  reference: string;
  /** Montant en GNF, entier. */
  amount: number;
  description: string;
  customerPhone?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  /** Où renvoyer le client après un paiement abouti. */
  returnUrl?: string;
  /** Où le renvoyer s'il abandonne ou si l'opérateur refuse. */
  cancelUrl?: string;
  /** Où Chap Chap doit nous rappeler. */
  notifyUrl: string;
}

/** Ce qu'on retient de sa réponse. */
export interface ChapChapOperation {
  /** Identifiant de l'opération chez Chap Chap. */
  providerRef: string;
  /** Page de paiement à ouvrir pour le client. */
  paymentUrl: string | null;
  /** Réponse brute, conservée pour le diagnostic. */
  raw: Record<string, unknown>;
}

/**
 * Chap Chap Pay — encaissement mobile money en Guinée.
 *
 * Deux échanges composent un paiement :
 *
 *  1. **La création** — on annonce un montant et une référence, Chap Chap
 *     renvoie une page où le client choisit son opérateur et valide.
 *  2. **Le rappel** — Chap Chap nous prévient du dénouement sur l'adresse
 *     que nous lui avons donnée. C'est ce rappel, et lui seul, qui fait foi :
 *     un client peut fermer son navigateur avant d'être redirigé, et le
 *     paiement aura pourtant abouti.
 *
 * Les deux sens sont signés en HMAC-SHA256. La vérification du rappel est
 * la barrière qui empêche n'importe qui de déclarer une commande payée.
 */
@Injectable()
export class ChapChapService {
  private readonly logger = new Logger(ChapChapService.name);

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<boolean>('payment.chapchap.enabled') === true;
  }

  /**
   * État de l'intégration, tel que le back-office peut l'afficher.
   *
   * Aucune clé n'y figure — ni la clé d'API, ni les secrets. Le gérant a
   * besoin de savoir si l'encaissement est actif et quelle adresse déclarer
   * chez Chap Chap ; il n'a jamais besoin de voir les secrets, et un écran
   * qui les affiche est un écran qu'on photographie.
   */
  status() {
    const notifyUrl = this.notifyUrl();
    const allowUnsigned = this.config.get<boolean>('payment.chapchap.allowUnsigned') === true;
    const hasDedicatedWebhookSecret = Boolean(process.env.CHAPCHAP_WEBHOOK_SECRET);

    return {
      provider: 'chapchap' as const,
      label: 'Chap Chap Pay',
      enabled: this.enabled,
      /** Vrai tant que les paiements sont simulés localement. */
      sandbox: this.config.get<boolean>('payment.sandbox') === true,
      baseUrl: this.config.get<string>('payment.chapchap.baseUrl') ?? '',
      ecommercePath: this.config.get<string>('payment.chapchap.ecommercePath') ?? '',
      bodyStyle: this.config.get<string>('payment.chapchap.bodyStyle') ?? 'snake',
      signatureHeader: this.config.get<string>('payment.chapchap.signatureHeader') ?? '',
      /** À déclarer chez Chap Chap : c'est là qu'il doit rappeler. */
      notifyUrl,
      /** Faux si l'adresse pointe encore sur la machine de développement. */
      notifyUrlReachable: !/localhost|127\.0\.0\.1/.test(notifyUrl),
      /**
       * Page d'atterrissage du client après paiement.
       *
       * Nulle tant qu'aucun site n'est déclaré : l'opérateur laisse alors
       * le client sur sa propre page de confirmation. Gênant, pas grave —
       * l'encaissement, lui, aboutit quand même.
       */
      returnUrl: this.returnUrl() ?? null,
      hasDedicatedWebhookSecret,
      allowUnsigned,
    };
  }

  /**
   * Adresse publique que Chap Chap rappellera.
   *
   * Bâtie sur `CHAPCHAP_PUBLIC_BASE_URL` et non sur `API_URL` : en
   * développement cette dernière vaut `localhost`, que les serveurs de
   * l'opérateur ne peuvent pas joindre. Le rappel n'arriverait jamais et
   * le paiement resterait indéfiniment « en cours ».
   */
  notifyUrl(): string {
    return this.join(
      this.config.get<string>('payment.chapchap.publicBaseUrl') ?? '',
      this.config.get<string>('payment.chapchap.notifyPath') ?? '',
    );
  }

  /**
   * Pages d'atterrissage du client.
   *
   * Purement cosmétiques : elles ne prouvent rien. Le client peut fermer
   * son navigateur avant d'y arriver, ou les rejouer après un échec —
   * seul le rappel signé décide qu'une commande est payée. Elles servent
   * à ne pas laisser le client devant la page de l'opérateur, rien de
   * plus.
   *
   * Vides tant que `CHAPCHAP_FRONTEND_BASE_URL` n'est pas renseignée :
   * mieux vaut ne rien envoyer à l'opérateur qu'une adresse inventée.
   */
  returnUrl(reference?: string): string | undefined {
    return this.landing('payment.chapchap.returnPath', reference);
  }

  cancelUrl(reference?: string): string | undefined {
    return this.landing('payment.chapchap.cancelPath', reference);
  }

  private landing(pathKey: string, reference?: string): string | undefined {
    const base = this.config.get<string>('payment.chapchap.frontendBaseUrl') ?? '';
    if (!base) return undefined;

    const url = this.join(base, this.config.get<string>(pathKey) ?? '');
    // La référence permet à la page d'afficher la bonne commande sans
    // avoir à deviner laquelle vient d'être réglée.
    return reference ? `${url}?reference=${encodeURIComponent(reference)}` : url;
  }

  /** Recolle une base et un chemin sans doubler ni perdre la barre. */
  private join(base: string, path: string): string {
    const root = base.replace(/\/$/, '');
    return `${root}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * Demande l'état d'une opération, au lieu d'attendre son rappel.
   *
   * Le rappel reste la voie normale : il arrive dans la seconde et ne
   * coûte aucune requête. Mais il suppose que notre serveur soit
   * joignable **depuis l'extérieur** — ce qui n'est jamais vrai sur une
   * machine de développement, et peut cesser de l'être en production le
   * temps d'une coupure. Pouvoir demander transforme un point de panne
   * unique en simple retard.
   *
   * Chap Chap retrouve l'opération par la référence que nous lui avons
   * donnée à la création (`order_id`), d'où l'envoi de celle-ci.
   *
   * Rend `null` si l'opération est inconnue ou l'API injoignable :
   * l'appelant garde alors l'état qu'il avait.
   */
  async readOperation(reference: string): Promise<Record<string, unknown> | null> {
    if (!this.enabled) return null;

    const baseUrl = this.config.get<string>('payment.chapchap.baseUrl') ?? '';
    const apiKey = this.config.get<string>('payment.chapchap.apiKey') ?? '';

    try {
      const response = await fetch(
        `${baseUrl}/ecommerce/order/${encodeURIComponent(reference)}`,
        {
          headers: { 'CCP-Api-Key': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) return null;
      return this.parse(await response.text());
    } catch (error) {
      this.logger.warn(
        `État de l'opération ${reference} indisponible : ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Ouvre une opération de paiement.
   *
   * Le corps est signé tel qu'il part sur le réseau — la signature porte
   * sur la chaîne exacte, pas sur l'objet : re-sérialiser après signature
   * suffirait à l'invalider.
   */
  async createOperation(input: ChapChapOperationInput): Promise<ChapChapOperation> {
    const baseUrl = this.config.get<string>('payment.chapchap.baseUrl') ?? '';
    const path = this.config.get<string>('payment.chapchap.ecommercePath') ?? '';
    const apiKey = this.config.get<string>('payment.chapchap.apiKey') ?? '';
    const secret = this.config.get<string>('payment.chapchap.hmacSecret') ?? '';
    const style = this.config.get<string>('payment.chapchap.bodyStyle') ?? 'snake';

    const payload = this.toBodyStyle(
      {
        reference: input.reference,
        /*
         * Notre référence, sous le nom que Chap Chap emploie pour
         * retrouver une opération : `GET /ecommerce/order/<order_id>`.
         *
         * Sans elle, l'opération n'est interrogeable par rien de ce que
         * nous conservons, et le rappel devient le **seul** moyen
         * d'apprendre le dénouement — donc un point de panne unique.
         */
        orderId: input.reference,
        amount: input.amount,
        currency: 'GNF',
        description: input.description,
        customerPhone: input.customerPhone ?? undefined,
        customerName: input.customerName ?? undefined,
        customerEmail: input.customerEmail ?? undefined,
        returnUrl: input.returnUrl,
        cancelUrl: input.cancelUrl,
        notifyUrl: input.notifyUrl,
      },
      style === 'camel' ? 'camel' : 'snake',
    );

    const body = JSON.stringify(payload);
    const signature = this.sign(body, secret);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Chap Chap attend sa clé sous ce nom précis, et refuse la
          // requête avec « API Key is required » si elle arrive
          // autrement. Les en-têtes usuels — `Authorization: Bearer`,
          // `X-API-KEY` — ne sont pas lus : ils étaient envoyés ici et
          // n'ont jamais authentifié quoi que ce soit.
          'CCP-Api-Key': apiKey,
          [this.signatureHeaderName()]: signature,
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = this.parse(text);

      if (!response.ok) {
        // Le message de l'opérateur est plus utile que le nôtre : on le
        // remonte tel quel dans les journaux.
        this.logger.error(
          `Chap Chap a refusé l'opération ${input.reference} (${response.status}) : ${text.slice(0, 400)}`,
        );
        throw AppException.badRequest(
          ERROR_CODES.PAYMENT_FAILED,
          this.messageOf(parsed) ?? "L'opérateur de paiement a refusé la transaction.",
        );
      }

      const providerRef = this.pick(parsed, [
        'transaction_id',
        'transactionId',
        'operation_id',
        'operationId',
        'id',
        'reference',
      ]);

      const paymentUrl = this.pick(parsed, [
        'payment_url',
        'paymentUrl',
        'checkout_url',
        'checkoutUrl',
        'url',
        'link',
      ]);

      if (!providerRef) {
        this.logger.warn(
          `Réponse Chap Chap sans identifiant d'opération pour ${input.reference} : ${text.slice(0, 400)}`,
        );
      }

      return {
        providerRef: providerRef ?? input.reference,
        paymentUrl: paymentUrl ?? null,
        raw: parsed,
      };
    } catch (error) {
      if (error instanceof AppException) throw error;

      const reason = (error as Error).name === 'AbortError' ? 'délai dépassé' : (error as Error).message;
      this.logger.error(`Chap Chap injoignable pour ${input.reference} : ${reason}`);
      throw AppException.badRequest(
        ERROR_CODES.PAYMENT_FAILED,
        "L'opérateur de paiement est momentanément injoignable. Réessayez dans un instant.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Vérifie l'authenticité d'un rappel.
   *
   * La signature se calcule sur le **corps brut** reçu, pas sur l'objet
   * reconstruit : `JSON.parse` puis `JSON.stringify` réordonne les clés et
   * change les espaces, ce qui produirait une signature différente pour un
   * message pourtant authentique.
   */
  verifyWebhook(rawBody: Buffer | string | undefined, signature: string | undefined): boolean {
    const allowUnsigned = this.config.get<boolean>('payment.chapchap.allowUnsigned') === true;
    const secret = this.config.get<string>('payment.chapchap.webhookSecret') ?? '';

    if (!signature) {
      if (allowUnsigned) {
        this.logger.warn(
          'Rappel Chap Chap accepté sans signature (CHAPCHAP_WEBHOOK_ALLOW_UNSIGNED). À proscrire hors développement.',
        );
        return true;
      }
      return false;
    }

    if (!secret || rawBody === undefined) return false;

    const expected = this.sign(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      secret,
    );

    // Comparaison à durée constante : une comparaison ordinaire s'arrête au
    // premier caractère différent et laisse deviner la signature.
    const left = Buffer.from(expected);
    const right = Buffer.from(signature.trim().replace(/^sha256=/i, ''));
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  /** Nom de l'en-tête de signature, tel que Chap Chap l'envoie. */
  signatureHeaderName(): string {
    return this.config.get<string>('payment.chapchap.signatureHeader') ?? 'ccp-hmac-signature';
  }

  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }

  /**
   * Adapte le nommage des champs.
   *
   * Chap Chap n'annonce pas la même convention selon les intégrations :
   * `CHAPCHAP_REQUEST_BODY_STYLE` permet de basculer sans toucher au code.
   */
  private toBodyStyle(
    payload: Record<string, unknown>,
    style: 'snake' | 'camel',
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue;
      const name =
        style === 'snake' ? key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`) : key;
      result[name] = value;
    }

    return result;
  }

  private parse(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { raw: text };
    } catch {
      return { raw: text };
    }
  }

  /**
   * Lit la première clé présente, y compris dans un objet `data` imbriqué.
   *
   * Les opérateurs enveloppent souvent leur réponse ; chercher aux deux
   * niveaux évite de dépendre d'une forme précise.
   */
  private pick(source: Record<string, unknown>, keys: string[]): string | null {
    const nested = source.data;
    const candidates: Record<string, unknown>[] = [source];
    if (typeof nested === 'object' && nested !== null) {
      candidates.push(nested as Record<string, unknown>);
    }

    for (const candidate of candidates) {
      for (const key of keys) {
        const value = candidate[key];
        if (typeof value === 'string' && value.length > 0) return value;
        if (typeof value === 'number') return String(value);
      }
    }

    return null;
  }

  private messageOf(parsed: Record<string, unknown>): string | null {
    return this.pick(parsed, ['message', 'error', 'detail', 'description']);
  }
}
