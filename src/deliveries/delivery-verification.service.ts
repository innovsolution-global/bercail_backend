import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import { randomNumericCode, sha256 } from '../common/utils/crypto.util';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Code de remise (OTP de livraison).
 *
 * Le client reçoit un code à la prise en charge de sa commande ; le
 * livreur le saisit au moment de la remise. C'est la preuve que le repas
 * a bien été donné à la bonne personne.
 *
 * Défenses en place :
 *  - le code n'est jamais stocké en clair (SHA-256) ;
 *  - il expire ;
 *  - il est à usage unique ;
 *  - le nombre de tentatives est plafonné, en base **et** dans Redis
 *    (un compteur en cache seul se contourne en attendant un redémarrage) ;
 *  - la comparaison porte sur des condensats, donc à temps constant.
 */
@Injectable()
export class DeliveryVerificationService {
  private readonly logger = new Logger(DeliveryVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private get length(): number {
    return this.config.get<number>('otp.length') ?? 4;
  }

  private get ttlMinutes(): number {
    return this.config.get<number>('otp.ttlMinutes') ?? 60;
  }

  private get maxAttempts(): number {
    return this.config.get<number>('otp.maxAttempts') ?? 5;
  }

  /**
   * Génère (ou régénère) le code d'une livraison.
   * Renvoie le code en clair : c'est le seul moment où il existe en clair,
   * juste le temps d'être notifié au client.
   */
  async issue(deliveryId: string, client: Prisma.TransactionClient = this.prisma): Promise<string> {
    const code = randomNumericCode(this.length);
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);

    await client.deliveryVerificationCode.upsert({
      where: { deliveryId },
      update: {
        codeHash: sha256(code),
        attempts: 0,
        maxAttempts: this.maxAttempts,
        expiresAt,
        verifiedAt: null,
        lastAttemptAt: null,
      },
      create: {
        deliveryId,
        codeHash: sha256(code),
        maxAttempts: this.maxAttempts,
        expiresAt,
      },
    });

    return code;
  }

  /**
   * Vérifie le code saisi par le livreur.
   * Toute tentative — réussie ou non — est comptabilisée.
   */
  async verify(deliveryId: string, code: string): Promise<void> {
    const throttleKey = `otp:delivery:${deliveryId}`;
    const attempts = await this.redis.increment(throttleKey, this.ttlMinutes * 60);

    if (attempts > this.maxAttempts * 2) {
      throw AppException.tooManyRequests(
        ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
        'Trop de tentatives. Contactez le restaurant.',
      );
    }

    const stored = await this.prisma.deliveryVerificationCode.findUnique({ where: { deliveryId } });

    if (!stored) {
      throw AppException.badRequest(
        ERROR_CODES.OTP_INVALID,
        "Aucun code de confirmation n'a été généré pour cette livraison.",
      );
    }

    if (stored.verifiedAt) {
      throw AppException.conflict(ERROR_CODES.OTP_ALREADY_USED, 'Ce code a déjà été utilisé.');
    }

    if (stored.attempts >= stored.maxAttempts) {
      throw AppException.tooManyRequests(
        ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
        'Nombre de tentatives dépassé. Contactez le restaurant pour débloquer la livraison.',
      );
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw AppException.badRequest(
        ERROR_CODES.OTP_EXPIRED,
        'Ce code a expiré. Demandez au client de faire régénérer un code.',
      );
    }

    const matches = sha256(code.trim()) === stored.codeHash;

    await this.prisma.deliveryVerificationCode.update({
      where: { deliveryId },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        ...(matches ? { verifiedAt: new Date() } : {}),
      },
    });

    if (!matches) {
      const remaining = Math.max(0, stored.maxAttempts - stored.attempts - 1);
      throw AppException.badRequest(
        ERROR_CODES.OTP_INVALID,
        remaining > 0
          ? `Code incorrect. Il reste ${remaining} tentative(s).`
          : 'Code incorrect. Plus aucune tentative disponible.',
      );
    }

    await this.redis.del(throttleKey);
  }

  /** Le client peut relire son code depuis l'application. */
  async statusFor(deliveryId: string) {
    const stored = await this.prisma.deliveryVerificationCode.findUnique({ where: { deliveryId } });
    if (!stored) return null;

    return {
      expiresAt: stored.expiresAt.toISOString(),
      verified: stored.verifiedAt !== null,
      attemptsLeft: Math.max(0, stored.maxAttempts - stored.attempts),
    };
  }
}
