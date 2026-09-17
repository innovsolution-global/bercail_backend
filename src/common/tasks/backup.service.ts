import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

const run = promisify(execFile);

/**
 * Sauvegarde de la base de données.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le 12 septembre 2026, la base de développement a été **entièrement
 * vidée** par un `prisma migrate dev` : l'outil a jugé le schéma en
 * dérive et l'a réinitialisé. Comptes, commandes, adresses, photos — tout
 * est parti, et il n'existait aucune copie. Le propriétaire a perdu ses
 * données de travail, et il n'a pu que recréer ses comptes.
 *
 * Une base sans sauvegarde n'est pas une base : c'est un brouillon. Ce
 * service fait un `pg_dump` **chaque nuit à 2 h**, et un autre **au
 * démarrage du serveur** — de sorte qu'il existe toujours une copie
 * récente avant qu'on touche à quoi que ce soit. Les copies vivent dans
 * `backend/backups/`, quatorze jours, au format compressé de Postgres.
 *
 * ## Restaurer
 *
 *     pg_restore --clean --if-exists -d bercail backups/bercail-2026-09-12T02-00-00.dump
 *
 * ## Ce qu'il ne fait pas
 *
 * Il n'envoie rien hors de la machine : un disque qui meurt emporte les
 * copies avec lui. En production, `backups/` doit être répliqué ailleurs
 * — c'est le rôle de l'hébergeur, pas de ce service.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  /** Nombre de jours de copies conservées. */
  private static readonly RETENTION_DAYS = 14;

  constructor(private readonly config: ConfigService) {}

  /** Le dossier des copies, à côté du code. */
  private get dossier(): string {
    return resolve(process.cwd(), 'backups');
  }

  /**
   * `pg_dump`, s'il est trouvable.
   *
   * `PG_DUMP_PATH` d'abord ; sinon le binaire est cherché sur le PATH,
   * puis dans l'installation Windows standard de Postgres. Sans lui, le
   * service le dit une fois et se tait — mais il le dit.
   */
  private get pgDump(): string {
    const configure = this.config.get<string>('PG_DUMP_PATH');
    if (configure && existsSync(configure)) return configure;

    if (process.platform === 'win32') {
      for (const version of ['18', '17', '16', '15']) {
        const chemin = `C:\\Program Files\\PostgreSQL\\${version}\\bin\\pg_dump.exe`;
        if (existsSync(chemin)) return chemin;
      }
    }

    return 'pg_dump';
  }

  async onModuleInit(): Promise<void> {
    // Au démarrage, sans bloquer le serveur : la copie se fait pendant
    // que l'API commence à répondre.
    void this.sauvegarder('demarrage');
  }

  @Cron('0 2 * * *')
  async nuit(): Promise<void> {
    await this.sauvegarder('nuit');
  }

  /**
   * Fait une copie, puis efface celles de plus de quatorze jours.
   *
   * @returns Le chemin de la copie, ou `null` si elle a échoué.
   */
  async sauvegarder(motif: string): Promise<string | null> {
    const url = this.config.get<string>('DATABASE_URL') ?? process.env.DATABASE_URL;
    if (!url) {
      this.logger.error('Sauvegarde impossible : DATABASE_URL absent.');
      return null;
    }

    await mkdir(this.dossier, { recursive: true });

    // `?schema=public` est un paramètre de Prisma, pas de Postgres :
    // `pg_dump` le refuse (« invalid URI query parameter »). On le
    // retire, lui seul — les autres paramètres (sslmode…) restent.
    const cible = new URL(url);
    cible.searchParams.delete('schema');

    const horodatage = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fichier = join(this.dossier, `bercail-${horodatage}.dump`);

    try {
      // `-Fc` : le format compressé et sélectif de Postgres, celui que
      // `pg_restore` sait relire table par table.
      await run(this.pgDump, ['--format=custom', '--no-owner', '--file', fichier, cible.toString()], {
        timeout: 5 * 60 * 1000,
        windowsHide: true,
      });

      const taille = (await stat(fichier)).size;
      this.logger.log(
        `Sauvegarde (${motif}) : ${fichier} — ${(taille / 1024 / 1024).toFixed(1)} Mo.`,
      );

      await this.purger();
      return fichier;
    } catch (error) {
      // Un fichier vide laissé derrière se prendrait pour une copie
      // valable le jour où l'on en aura besoin.
      await unlink(fichier).catch(() => undefined);
      this.logger.error(
        `Sauvegarde (${motif}) impossible : ${(error as Error).message}. ` +
          'Vérifiez que pg_dump est installé (PG_DUMP_PATH).',
      );
      return null;
    }
  }

  private async purger(): Promise<void> {
    const limite = Date.now() - BackupService.RETENTION_DAYS * 24 * 3600 * 1000;
    const fichiers = await readdir(this.dossier);

    for (const nom of fichiers) {
      if (!nom.endsWith('.dump')) continue;
      const chemin = join(this.dossier, nom);
      const infos = await stat(chemin);
      if (infos.mtimeMs < limite) await unlink(chemin);
    }
  }
}
