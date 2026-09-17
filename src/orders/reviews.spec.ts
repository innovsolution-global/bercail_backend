import { MIN_REVIEWS_FOR_RATING, displayedRating } from '../common/utils/rating.util';
import { latestPerDish } from './reviews.service';

/**
 * « Votre note » sur la fiche d'un plat.
 *
 * Elle vivait dans la mémoire du téléphone et s'effaçait à la fermeture
 * de l'application ; elle vient maintenant des avis déposés.
 */
describe('Mes notes de plats', () => {
  it('garde la note la plus récente quand un plat a été noté plusieurs fois', () => {
    const notes = latestPerDish([
      { menuItemId: 'poulet', rating: 5, review: { orderId: 'o2', createdAt: new Date('2026-09-14') } },
      { menuItemId: 'bissap', rating: 3, review: { orderId: 'o2', createdAt: new Date('2026-09-14') } },
      { menuItemId: 'poulet', rating: 2, review: { orderId: 'o1', createdAt: new Date('2026-09-01') } },
    ]);

    expect(notes).toEqual([
      { menuItemId: 'poulet', rating: 5, orderId: 'o2', ratedAt: '2026-09-14T00:00:00.000Z' },
      { menuItemId: 'bissap', rating: 3, orderId: 'o2', ratedAt: '2026-09-14T00:00:00.000Z' },
    ]);
  });

  it('ignore un plat retiré de la carte depuis', () => {
    expect(
      latestPerDish([
        { menuItemId: null, rating: 4, review: { orderId: 'o1', createdAt: new Date() } },
      ]),
    ).toEqual([]);
  });
});

describe('La note qu’on montre', () => {
  it('reste nulle tant que le seuil d’avis n’est pas atteint', () => {
    // Un « 5,0 » après le premier client n'est pas une moyenne.
    expect(displayedRating(5, 1)).toBeNull();
    expect(displayedRating(4.6, MIN_REVIEWS_FOR_RATING - 1)).toBeNull();
    expect(displayedRating(null, 0)).toBeNull();
  });

  it('s’arrondit à une décimale une fois le seuil atteint', () => {
    expect(displayedRating(4.333333, MIN_REVIEWS_FOR_RATING)).toBe(4.3);
    expect(displayedRating(4.96, 12)).toBe(5);
  });
});
