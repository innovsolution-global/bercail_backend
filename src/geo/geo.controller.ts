import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Public } from '../common/decorators';
import { referentielGuinee } from './referentiel';

/**
 * Le découpage administratif, pour les formulaires d'adresse.
 *
 * Servi par l'API plutôt qu'écrit dans chaque application : c'est le
 * serveur qui refuse une ville hors référentiel, et les deux listes
 * doivent être la même — sinon l'application proposerait une ville que le
 * serveur rejetterait ensuite, formulaire rempli.
 */
@ApiTags('Géographie')
@Controller('geo')
export class GeoController {
  @Get('guinee')
  @Public()
  @ApiEndpoint({
    summary: 'Régions et préfectures de Guinée',
    description:
      'Le référentiel des adresses : Conakry et ses communes, puis les sept régions avec leurs préfectures.',
    public: true,
  })
  guinee() {
    return referentielGuinee();
  }
}
