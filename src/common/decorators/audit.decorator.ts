import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

export interface AuditOptions {
  action: string;
  module: string;
  entityType?: string;
  /** Nom du paramètre de route portant l'identifiant de l'entité. */
  entityIdParam?: string;
}

/**
 * Journalise automatiquement une action sensible.
 *
 * L'intercepteur d'audit écrit une entrée (succès ou échec) avec l'auteur,
 * l'IP et l'user-agent. Les services peuvent en plus enregistrer le
 * différentiel avant/après via `AuditService.record`.
 */
export const Audit = (options: AuditOptions) => SetMetadata(AUDIT_KEY, options);
