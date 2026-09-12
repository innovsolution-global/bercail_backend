import { enFrancais } from './validation-messages';

/**
 * Les refus de validation se lisent en français.
 *
 * `class-validator` écrit les siens en anglais, et l'application mobile
 * affiche le message du serveur **tel quel** — elle n'a aucun texte de
 * secours. Un livreur devant sa commande a donc lu « property
 * confirmationCode should not exist » en plein service.
 *
 * Le contrat de l'API est que ses messages sont directement affichables.
 * Ces tests le tiennent aux deux bouts : on traduit ce qui vient de la
 * bibliothèque, on ne touche pas à ce qu'un DTO a rédigé lui-même.
 */
describe('Messages de validation', () => {
  it('traduit le refus d’un champ inconnu', () => {
    expect(
      enFrancais(
        'whitelistValidation',
        'confirmationCode',
        'property confirmationCode should not exist',
      ),
    ).toBe('Le champ « confirmationCode » n’est pas attendu ici.');
  });

  it('traduit les contraintes courantes', () => {
    expect(enFrancais('isNotEmpty', 'reason', 'reason should not be empty')).toBe(
      'Le champ « reason » est obligatoire.',
    );
    expect(enFrancais('isString', 'code', 'code must be a string')).toBe(
      'Le champ « code » doit être du texte.',
    );
    expect(enFrancais('isLatitude', 'latitude', 'latitude must be a latitude string or number')).toBe(
      'La latitude n’est pas valide.',
    );
  });

  it('laisse intact un message écrit dans le DTO', () => {
    // « code doit être numérique. » dit mieux les choses que n'importe
    // quelle traduction générique : il connaît la règle exacte.
    expect(enFrancais('matches', 'code', 'code doit être numérique.')).toBe(
      'code doit être numérique.',
    );
    expect(enFrancais('matches', 'phone', 'phone doit être un numéro valide.')).toBe(
      'phone doit être un numéro valide.',
    );
  });

  it('rend une phrase française même pour une contrainte imprévue', () => {
    // Mieux vaut une phrase vague en français qu'une phrase précise en
    // anglais, que personne ne lira ici.
    expect(enFrancais('isDivisibleBy', 'quantity', 'quantity must be divisible by 3')).toBe(
      'Le champ « quantity » n’est pas valide.',
    );
  });
});
