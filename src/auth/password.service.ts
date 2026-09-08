import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

/**
 * Politique et hachage des mots de passe.
 *
 * bcrypt avec un coût configurable (12 par défaut). La comparaison passe
 * toujours par bcrypt, y compris quand l'utilisateur n'existe pas : sinon
 * la différence de durée révélerait quels e-mails sont enregistrés.
 */
@Injectable()
export class PasswordService {
  private readonly rounds: number;
  private readonly minLength: number;
  /** Condensat bidon utilisé pour égaliser le temps de réponse. */
  private readonly dummyHash: string;

  constructor(private readonly config: ConfigService) {
    this.rounds = this.config.get<number>('security.bcryptRounds') ?? 12;
    this.minLength = this.config.get<number>('security.passwordMinLength') ?? 8;
    this.dummyHash = bcrypt.hashSync('bercail-dummy-password', 10);
  }

  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** Consomme le même temps qu'une vraie comparaison. */
  async wasteTime(): Promise<void> {
    await bcrypt.compare('bercail-dummy-password', this.dummyHash);
  }

  /**
   * Règles de robustesse.
   * Elles s'appliquent aussi aux mots de passe générés par le backend.
   */
  validate(password: string): void {
    const problems: string[] = [];

    if (password.length < this.minLength) {
      problems.push(`au moins ${this.minLength} caractères`);
    }
    if (!/[a-z]/.test(password)) problems.push('une minuscule');
    if (!/[A-Z]/.test(password)) problems.push('une majuscule');
    if (!/[0-9]/.test(password)) problems.push('un chiffre');

    if (problems.length > 0) {
      throw AppException.unprocessable(
        ERROR_CODES.VALIDATION_ERROR,
        `Le mot de passe doit contenir ${problems.join(', ')}.`,
        { errors: { password: `Le mot de passe doit contenir ${problems.join(', ')}.` } },
      );
    }
  }
}
