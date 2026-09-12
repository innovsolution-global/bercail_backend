import { ValidationPipe } from '@nestjs/common';
import { AppException, ERROR_CODES } from '../exceptions/app.exception';
import { enFrancais } from './validation-messages';

/**
 * Pipe de validation de l'application.
 *
 * Défini une seule fois et monté comme `APP_PIPE` : le serveur de
 * production et le socle de tests appliquent donc exactement les mêmes
 * règles. Un harnais de test plus permissif que la production est une
 * source classique de bugs qui ne se révèlent qu'en ligne.
 *
 * `forbidNonWhitelisted` est le point le plus important : un champ inconnu
 * est refusé, et non silencieusement ignoré. C'est ainsi qu'un `total` ou
 * un `role` glissé dans le corps par un client n'a aucune chance
 * d'atteindre la logique métier.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => {
      const fieldErrors: Record<string, string> = {};
      for (const error of errors) {
        const constraints = error.constraints;
        if (!constraints) continue;

        // `class-validator` écrit en anglais. L'application mobile
        // affiche le message du serveur tel quel, sans texte de
        // secours : un livreur a donc pu lire « property
        // confirmationCode should not exist » en plein service.
        const [contrainte, message] = Object.entries(constraints)[0];
        fieldErrors[error.property] = enFrancais(contrainte, error.property, message);
      }

      return AppException.unprocessable(
        ERROR_CODES.VALIDATION_ERROR,
        Object.values(fieldErrors)[0] ?? 'Certains champs sont invalides.',
        { errors: fieldErrors },
      );
    },
  });
}
