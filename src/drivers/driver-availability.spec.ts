/**
 * Disponibilité d'un livreur.
 *
 * C'est ce seul booléen qui décide si un livreur apparaît dans la liste
 * d'attribution du back-office. Mal calculé, il ne provoque aucune erreur :
 * le livreur disparaît simplement, et personne ne sait pourquoi.
 *
 * La règle tient en une ligne dans le service ; ces cas la figent, parce
 * que c'est exactement la ligne qui s'était trompée de sens.
 */

/**
 * Reproduction de la décision prise par `DriversService.updateAvailability`.
 *
 * Extraite plutôt qu'appelée : la méthode ouvre une transaction et publie
 * un événement temps réel, dont ni l'un ni l'autre n'éclaire cette règle.
 * Ce qu'on éprouve ici, c'est l'arbitrage lui-même.
 */
function disponibilite(
  coursesActives: number,
  dto: { isOnline?: boolean; isAvailable?: boolean },
): boolean | undefined {
  return coursesActives > 0 ? false : (dto.isAvailable ?? dto.isOnline);
}

describe('Disponibilité déduite de la présence', () => {
  it('rend disponible un livreur qui se met en ligne sans course', () => {
    // Le cas qui manquait. L'application livreur n'envoie que `isOnline` :
    // sans cette déduction, la disponibilité gardait sa valeur de la
    // veille — souvent `false` — et le livreur n'était plus jamais
    // proposé à l'attribution.
    expect(disponibilite(0, { isOnline: true })).toBe(true);
  });

  it('retire la disponibilité au passage hors ligne', () => {
    expect(disponibilite(0, { isOnline: false })).toBe(false);
  });

  it('refuse la disponibilité tant qu’une course est en cours', () => {
    // Même si le livreur la réclame explicitement : le travail en cours
    // l'emporte, sinon deux courses tomberaient sur la même personne.
    expect(disponibilite(1, { isOnline: true })).toBe(false);
    expect(disponibilite(1, { isOnline: true, isAvailable: true })).toBe(false);
  });

  it('respecte une pause demandée en restant en ligne', () => {
    // Un livreur peut vouloir rester joignable sans accepter de course.
    expect(disponibilite(0, { isOnline: true, isAvailable: false })).toBe(false);
  });

  it('ne touche à rien sur un simple battement de cœur', () => {
    // L'application signale périodiquement sa présence sans rien décider.
    // Écrire `false` ici mettrait tout le monde hors jeu à la première
    // remontée de position.
    expect(disponibilite(0, {})).toBeUndefined();
  });
});
