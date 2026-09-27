import { readFileSync, statSync } from 'node:fs';
import { parseSheet, type Sheet } from '../sheet';
import * as autoscout24 from './autoscout24';
import { ReadError } from './errors';
import * as leboncoin from './leboncoin';

export { ReadError, type ReadFailureReason } from './errors';

/** Where the sheet came from: a listing read by the server, a browser export, or a sheet file. */
export type SourceOrigin = 'url' | 'export' | 'fiche';

export type ReadSourceDeps = { fetch?: typeof globalThis.fetch };

type Reader = {
  PLATFORM: string;
  canHandle(url: string): boolean;
  read(url: string, deps: { fetch: typeof globalThis.fetch }): Promise<Sheet>;
};

/** One module per platform (CLAUDE.md, Conventions). */
export const READERS: readonly Reader[] = [autoscout24, leboncoin];

/** An export or a sheet is a few hundred KB at most. */
const MAX_FILE_BYTES = 5_000_000;

export const SUPPORTED_INPUTS = [
  'le lien d’une annonce AutoScout24.fr (https://www.autoscout24.fr/offres/…)',
  'le fichier .json d’une annonce Leboncoin exporté avec le favori d’export (npm run bookmarklet)',
  'le fichier .json d’une fiche (formulaire de secours ou extension)',
];

function unsupported(input: string, why: string): ReadError {
  const shown = input.length > 200 ? `${input.slice(0, 200)}…` : input;
  return new ReadError(
    'unknown',
    'unsupported',
    `${why} : « ${shown} ». Entrées acceptées :\n- ${SUPPORTED_INPUTS.join(' ;\n- ')}.`,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function fromFile(path: string): { sheet: Sheet; origin: SourceOrigin } {
  if (statSync(path).size > MAX_FILE_BYTES) {
    throw new ReadError('file', 'invalid-input', `Le fichier ${path} est trop gros pour être un export ou une fiche.`);
  }
  let json: unknown;
  try {
    // A byte order mark (files saved by some Windows editors) is not JSON.
    json = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new ReadError('file', 'invalid-input', `Le fichier ${path} n’est pas un JSON valide.`);
  }
  if (leboncoin.isExport(json)) {
    return { sheet: leboncoin.fromExport(json), origin: 'export' };
  }
  if (typeof json === 'object' && json !== null && 'vertical' in json) {
    try {
      return { sheet: parseSheet(json), origin: 'fiche' };
    } catch (err) {
      throw new ReadError('file', 'invalid-input', err instanceof Error ? err.message : String(err));
    }
  }
  throw unsupported(path, 'Fichier JSON de format inconnu');
}

/**
 * The sheet of one input: a path to an export or sheet file, or the URL of one
 * listing, read by the reader of its platform. One listing per call (rule 1).
 */
export async function readSource(input: string, deps: ReadSourceDeps = {}): Promise<{ sheet: Sheet; origin: SourceOrigin }> {
  const trimmed = input.trim();
  if (isFile(trimmed)) return fromFile(trimmed);

  const url = toUrl(trimmed);
  if (!url) throw unsupported(trimmed, 'Ni un fichier existant ni un lien');
  const reader = READERS.find((r) => r.canHandle(trimmed));
  if (!reader) throw unsupported(trimmed, 'Lien non pris en charge');
  const sheet = await reader.read(trimmed, { fetch: deps.fetch ?? globalThis.fetch });
  return { sheet, origin: 'url' };
}
