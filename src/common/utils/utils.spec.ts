import { OrderStatus, PaymentMethod } from '@prisma/client';
import { sha256, randomNumericCode, randomPassword, safeCompare } from './crypto.util';
import { buildCsv } from './csv.util';
import { distanceKm, distanceMeters, estimatedMinutes, isValidCoordinates } from './geo.util';
import { capDiscount, clampToZero, formatAmount, percentageOf, sum } from './money.util';
import { generateOrderReference, slugify } from './reference.util';
import { fromWire, parseEnum, toWire, wireValues } from './wire-enum.util';

describe('Arithmétique monétaire', () => {
  it('additionne des entiers sans erreur de flottant', () => {
    expect(sum([145000, 5000, 8000])).toBe(158000);
  });

  it('arrondit une remise à l’entier inférieur', () => {
    // 10 % de 145 555 = 14 555,5 → 14 555 : le client n'est jamais
    // surfacturé d'un franc.
    expect(percentageOf(145555, 10)).toBe(14555);
  });

  it('plafonne une remise', () => {
    expect(capDiscount(29000, 20000)).toBe(20000);
    expect(capDiscount(15000, 20000)).toBe(15000);
    expect(capDiscount(15000, null)).toBe(15000);
  });

  it('empêche un montant négatif', () => {
    expect(clampToZero(-5000)).toBe(0);
    expect(clampToZero(5000)).toBe(5000);
  });

  it('formate un montant lisible en GNF', () => {
    expect(formatAmount(145000)).toBe('145 000 GNF');
  });
});

describe('Traduction des énumérations', () => {
  it('sérialise en minuscules vers le réseau', () => {
    expect(toWire(OrderStatus.OUT_FOR_DELIVERY)).toBe('out_for_delivery');
    expect(toWire(PaymentMethod.CASH_ON_DELIVERY)).toBe('cash_on_delivery');
    expect(toWire(null)).toBeNull();
  });

  it('accepte les deux casses en entrée', () => {
    expect(fromWire('out_for_delivery')).toBe('OUT_FOR_DELIVERY');
    expect(fromWire('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
  });

  it('valide l’appartenance à l’énumération', () => {
    expect(parseEnum(OrderStatus, 'preparing')).toBe(OrderStatus.PREPARING);
    expect(parseEnum(OrderStatus, 'PREPARING')).toBe(OrderStatus.PREPARING);
    expect(parseEnum(OrderStatus, 'inexistant')).toBeUndefined();
    // `all` est le « pas de filtre » des listes : il ne doit pas filtrer.
    expect(parseEnum(OrderStatus, 'all')).toBeUndefined();
    expect(parseEnum(OrderStatus, '')).toBeUndefined();
  });

  it('expose les valeurs au format réseau pour Swagger', () => {
    expect(wireValues(OrderStatus)).toContain('out_for_delivery');
    expect(wireValues(OrderStatus)).not.toContain('OUT_FOR_DELIVERY');
  });
});

describe('Primitives cryptographiques', () => {
  it('produit un condensat stable', () => {
    expect(sha256('1234')).toBe(sha256('1234'));
    expect(sha256('1234')).not.toBe(sha256('1235'));
    expect(sha256('1234')).toHaveLength(64);
  });

  it('génère un code numérique de la longueur demandée', () => {
    const code = randomNumericCode(4);
    expect(code).toMatch(/^[0-9]{4}$/);
  });

  it('génère un mot de passe conforme à la politique', () => {
    const password = randomPassword(12);
    expect(password).toHaveLength(12);
    expect(password).toMatch(/[0-9]/);
  });

  it('compare à temps constant sans se tromper de résultat', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });
});

describe('Références lisibles', () => {
  it('produit une référence de commande sans caractère ambigu', () => {
    const reference = generateOrderReference('BRC', new Date('2026-09-03T10:00:00Z'));
    expect(reference).toMatch(/^BRC-260903-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    // Ni O ni 0, ni I ni 1 : la référence se lit au téléphone.
    expect(reference.slice(11)).not.toMatch(/[O0I1]/);
  });

  it('produit des slugs propres à partir de noms accentués', () => {
    expect(slugify('Riz & Accompagnements')).toBe('riz-accompagnements');
    expect(slugify('Plats guinéens')).toBe('plats-guineens');
    expect(slugify('Entrées')).toBe('entrees');
  });
});

describe('Calculs géographiques', () => {
  const kaloum = { latitude: 9.509167, longitude: -13.712222 };
  const ratoma = { latitude: 9.585, longitude: -13.65 };

  it('mesure une distance plausible dans Conakry', () => {
    const meters = distanceMeters(kaloum, ratoma);
    expect(meters).toBeGreaterThan(8_000);
    expect(meters).toBeLessThan(15_000);
    expect(distanceKm(kaloum, ratoma)).toBeCloseTo(meters / 1000, 1);
  });

  it('renvoie zéro pour deux points identiques', () => {
    expect(distanceMeters(kaloum, kaloum)).toBe(0);
  });

  it('estime une durée de trajet réaliste', () => {
    // 5 km à 18 km/h ≈ 17 minutes.
    expect(estimatedMinutes(5000)).toBe(17);
    expect(estimatedMinutes(0)).toBe(1);
  });

  it('rejette des coordonnées invalides', () => {
    expect(isValidCoordinates(null)).toBe(false);
    expect(isValidCoordinates({ latitude: 200, longitude: 0 })).toBe(false);
    expect(isValidCoordinates({ latitude: 9.5, longitude: -13.7 })).toBe(true);
  });
});

describe('Export CSV', () => {
  it('échappe les séparateurs et les guillemets', () => {
    const csv = buildCsv([{ name: 'Poulet; braisé', note: 'Il a dit "merci"' }], [
      { header: 'Nom', value: (row) => row.name },
      { header: 'Note', value: (row) => row.note },
    ]);

    expect(csv).toContain('"Poulet; braisé"');
    expect(csv).toContain('"Il a dit ""merci"""');
  });

  it('commence par un BOM UTF-8 pour Excel', () => {
    const csv = buildCsv([{ value: 1 }], [{ header: 'Valeur', value: (row) => row.value }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
});
