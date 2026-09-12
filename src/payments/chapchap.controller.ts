import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { ChapChapService } from './chapchap.service';
import { PaymentsService } from './payments.service';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Corps brut, activé par `rawBody: true` au démarrage.
     *
     * Indispensable pour vérifier une signature : elle porte sur les octets
     * reçus, qu'un `JSON.parse` suivi d'un `JSON.stringify` ne restitue pas
     * à l'identique.
     */
    rawBody?: Buffer;
  }
}


/**
 * Rappels de Chap Chap Pay.
 *
 * C'est ce rappel — et lui seul — qui décide qu'une commande est payée. La
 * redirection du client après paiement ne prouve rien : il peut fermer son
 * navigateur avant, ou la rejouer après un échec.
 *
 * La route est publique par nécessité : Chap Chap n'a pas de compte chez
 * nous. Sa seule barrière est la **signature HMAC**, vérifiée sur le corps
 * brut. Sans elle, n'importe qui pourrait déclarer ses commandes réglées.
 */
@ApiExcludeController()
@Controller()
export class ChapChapWebhookController {
  private readonly logger = new Logger(ChapChapWebhookController.name);

  constructor(
    private readonly chapchap: ChapChapService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Le chemin doit correspondre à `CHAPCHAP_PUBLIC_NOTIFY_PATH`.
   *
   * Il est écrit en dur ici, et non lu de la configuration : un décorateur
   * Nest est évalué au chargement du module, bien avant que la
   * configuration ne soit disponible. Changer l'un oblige donc à changer
   * l'autre — le service journalise un avertissement si les deux divergent.
   */
  @Post('v1/webhooks/chapchap')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() request: Request, @Body() body: Record<string, unknown>) {
    const signature = request.headers[this.chapchap.signatureHeaderName()];
    const provided = Array.isArray(signature) ? signature[0] : signature;

    // `rawBody` est fourni par Nest (`rawBody: true` au démarrage) : la
    // signature porte sur les octets reçus, pas sur l'objet reconstruit.
    if (!this.chapchap.verifyWebhook(request.rawBody, provided)) {
      this.logger.warn(
        `Rappel Chap Chap rejeté : signature absente ou invalide (${JSON.stringify(body).slice(0, 200)}).`,
      );
      throw AppException.unauthorized(
        ERROR_CODES.UNAUTHORIZED,
        'Signature du rappel invalide.',
      );
    }

    await this.payments.applyChapChapCallback(body);

    // Chap Chap attend un accusé simple. Un code autre que 200 le ferait
    // réessayer — ce qui est souhaitable en cas de panne de notre côté, et
    // sans danger puisque le traitement est idempotent.
    return { received: true };
  }
}
