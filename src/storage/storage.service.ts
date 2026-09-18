import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';

/**
 * Fichier reçu par le serveur.
 *
 * Interface locale plutôt que dépendance aux types de multer : la forme
 * utilisée ici est stable, et le backend ne dépend pas d'un paquet de
 * types supplémentaire.
 */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export type StorageFolder = 'avatars' | 'menu' | 'restaurant' | 'promotions';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Stockage des fichiers.
 *
 * Abstraction volontairement étroite : « range ce fichier, donne-moi son
 * URL ». Le pilote local écrit sur disque (développement) ; un pilote S3
 * se branche en implémentant `putObject` sans toucher aux appelants.
 *
 * Sécurité : le type MIME est vérifié en liste blanche, la taille est
 * plafonnée, et le nom de fichier est **régénéré** — un nom fourni par le
 * client ne doit jamais atteindre le système de fichiers.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: string;
  private readonly localDir: string;
  private readonly publicUrl: string;
  private readonly maxSize: number;

  constructor(private readonly config: ConfigService) {
    this.driver = this.config.get<string>('storage.driver') ?? 'local';
    this.localDir = this.config.get<string>('storage.localDir') ?? 'uploads';
    this.publicUrl = this.config.get<string>('storage.publicUrl') ?? '/uploads';
    this.maxSize = this.config.get<number>('storage.maxFileSizeBytes') ?? 5 * 1024 * 1024;
  }

  get uploadRoot(): string {
    return resolve(process.cwd(), this.localDir);
  }

  async store(file: UploadedFileLike, folder: StorageFolder): Promise<{ url: string; path: string }> {
    this.assertValid(file);

    const extension = ALLOWED_MIME[file.mimetype] ?? extname(file.originalname).toLowerCase();
    // Nom régénéré : ni traversée de répertoire, ni collision, ni fuite
    // du nom d'origine.
    const filename = `${randomUUID()}${extension}`;
    const relativePath = `${folder}/${filename}`;

    if (this.driver === 's3') {
      return this.putObjectS3(relativePath, file);
    }

    const directory = join(this.uploadRoot, folder);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), file.buffer);

    return {
      url: `${this.publicUrl.replace(/\/$/, '')}/${relativePath}`,
      path: relativePath,
    };
  }

  async remove(relativePath: string): Promise<void> {
    if (this.driver === 's3') {
      this.logger.warn(`Suppression S3 non implémentée : ${relativePath}`);
      return;
    }

    // On refuse tout chemin qui sortirait du dossier de stockage.
    const target = resolve(this.uploadRoot, relativePath);
    if (!target.startsWith(this.uploadRoot)) {
      throw AppException.badRequest(ERROR_CODES.BAD_REQUEST, 'Chemin de fichier invalide.');
    }

    await unlink(target).catch(() => undefined);
  }

  private assertValid(file: UploadedFileLike): void {
    if (!file || !file.buffer) {
      throw AppException.badRequest(ERROR_CODES.BAD_REQUEST, 'Aucun fichier reçu.');
    }

    if (!ALLOWED_MIME[file.mimetype]) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        'Format non accepté. Formats autorisés : JPEG, PNG, WebP, GIF.',
      );
    }

    if (file.size > this.maxSize) {
      throw AppException.badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `Fichier trop volumineux (maximum ${Math.round(this.maxSize / 1024 / 1024)} Mo).`,
      );
    }
  }

  /**
   * Point d'extension pour un stockage compatible S3.
   *
   * À implémenter avec `@aws-sdk/client-s3` : `PutObjectCommand` sur le
   * bucket configuré, puis renvoyer l'URL publique. Les appelants n'ont
   * pas à changer.
   */
  private async putObjectS3(
    relativePath: string,
    _file: UploadedFileLike,
  ): Promise<{ url: string; path: string }> {
    throw AppException.badRequest(
      ERROR_CODES.SERVER_ERROR,
      "Le stockage S3 n'est pas configuré sur cette instance.",
      { path: relativePath },
    );
  }
}
