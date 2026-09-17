import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAddressDto } from '../addresses/dto/address.dto';
import { COMMUNES_DE_CONAKRY, REGIONS, VILLES, referentielGuinee, regionDe } from './referentiel';

/**
 * Le référentiel des adresses : Conakry et les préfectures de Guinée.
 *
 * Le fichier du propriétaire compte sept régions et trente-trois
 * préfectures ; Conakry, zone spéciale, y est ajoutée en tête. Une
 * adresse ne peut plus porter une ville hors de cette liste.
 */
describe('Référentiel de Guinée', () => {
  it('reprend les sept régions et trente-trois préfectures du fichier, plus Conakry', () => {
    expect(REGIONS).toHaveLength(8);
    expect(REGIONS[0]).toEqual({ nom: 'Conakry', prefectures: ['Conakry'] });
    expect(VILLES).toHaveLength(34);
    expect(REGIONS.map((r) => r.nom)).toEqual([
      'Conakry', 'Boké', 'Kindia', 'Mamou', 'Labé', 'Faranah', 'Kankan', "N'zérékoré",
    ]);
  });

  it('ne compte aucune préfecture deux fois : la ville suffit à retrouver la région', () => {
    expect(new Set(VILLES).size).toBe(VILLES.length);
    expect(regionDe('Kissidougou')).toBe('Faranah');
    expect(regionDe('Conakry')).toBe('Conakry');
    expect(regionDe('Dakar')).toBeNull();
    expect(regionDe(null)).toBeNull();
  });

  it('propose les treize communes de Conakry comme quartiers', () => {
    // Le découpage en vigueur, pas les cinq communes historiques : un
    // client de Sonfonia doit pouvoir nommer sa commune.
    expect(COMMUNES_DE_CONAKRY).toHaveLength(13);
    expect(COMMUNES_DE_CONAKRY).toEqual(
      expect.arrayContaining(['Kaloum', 'Matoto', 'Sonfonia', 'Lambanyi', 'Kassa']),
    );
    expect(referentielGuinee().communesDeConakry).toEqual(COMMUNES_DE_CONAKRY);
  });

  const adresse = (city?: string) =>
    plainToInstance(CreateAddressDto, {
      street: 'Rue KA 021',
      latitude: 9.5,
      longitude: -13.7,
      ...(city === undefined ? {} : { city }),
    });

  it('accepte Conakry et une préfecture, refuse une ville inventée', async () => {
    expect(await validate(adresse('Conakry'))).toHaveLength(0);
    expect(await validate(adresse('Kindia'))).toHaveLength(0);
    // Sans ville, la base retombe sur Conakry.
    expect(await validate(adresse())).toHaveLength(0);

    const erreurs = await validate(adresse('Kindia ville'));
    expect(erreurs).toHaveLength(1);
    expect(Object.values(erreurs[0].constraints ?? {})[0]).toMatch(/Ville inconnue/);
  });
});
