import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Exports CSV.
 *
 * Les exports sont produits par le serveur (jamais assemblés dans le
 * navigateur) : le back-office télécharge un fichier prêt à ouvrir dans
 * un tableur, avec un BOM UTF-8 pour qu'Excel affiche correctement les
 * accents et les caractères guinéens.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  // Séparateur point-virgule : c'est ce qu'attend un Excel en français.
  const header = columns.map((column) => escapeCell(column.header)).join(';');
  const body = rows
    .map((row) => columns.map((column) => escapeCell(column.value(row))).join(';'))
    .join('\n');
  return `﻿${header}\n${body}\n`;
}

export function csvResponse(response: Response, filename: string, content: string): StreamableFile {
  const stamp = new Date().toISOString().slice(0, 10);
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}-${stamp}.csv"`);
  return new StreamableFile(Buffer.from(content, 'utf-8'));
}
