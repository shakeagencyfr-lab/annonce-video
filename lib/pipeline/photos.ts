import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { z } from 'zod';
import { MODELS } from '../config';
import { claudeUsageLine } from '../costs';
import { ACCEPT_IMAGE, DEFAULT_USER_AGENT, requestHeaders } from '../probe/fetch';
import { sniffImage } from '../probe/images';
import { photosFinalPrompt, photosRetryPrompt, photosSystemPrompt, photosUserPrompt } from '../prompts/photos.v2';
import type { Sheet } from '../sheet';
import { largestVariant } from './photo-variants';
import {
  PHOTO_COUNT,
  PHOTO_ROLES,
  type ClaudeClient,
  type LocalPhoto,
  type PhotoRole,
  type PhotoSelection,
  type SelectedPhoto,
  type UsageLine,
} from './types';

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Most photos of the listing offered to the sort: this bounds the candidates, not the
 * photos kept (PHOTO_COUNT). A real pro Leboncoin ad had 42, with its best shots among
 * the last ones. Still one listing, fetched on demand: rule 1 is unaffected.
 */
export const MAX_PHOTOS = 50;
/** 3 at a time: the 42 photos (~100 KB each) of a Leboncoin ad took 3 s (28/09/2026). */
const CONCURRENCY = 3;
/** Per attempt; a photo makes two when its bigger variant fails. */
const TIMEOUT_MS = 15_000;
/**
 * No photo is started after this, so a host that lets every request time out cannot
 * hold the order for 50 x 2 x 15 s / 3 (over 8 min): the photos already downloaded are used.
 */
const DOWNLOAD_BUDGET_MS = 90_000;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const EXTENSIONS: Record<LocalPhoto['format'], string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
};

const isSupported = (format: string): format is LocalPhoto['format'] => format in EXTENSIONS;

export type DownloadDeps = { fetch: typeof fetch };
export type PhotoFailure = { index: number; url: string; reason: string };

/**
 * Photo URLs come from the sheet, so from the listing or the seller's browser: only
 * plain https on a named host is fetched (no IP, no port, no credentials).
 */
function refusal(url: URL): string | null {
  if (url.protocol !== 'https:') return 'adresse refusée : https uniquement';
  if (url.username || url.password || url.port) return 'adresse refusée : identifiants ou port dans l’URL';
  // The URL parser already turns 0x7f.1, 2130706433 or 127.0.0.1. into 127.0.0.1.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') || /^[\d.]+$/.test(host)) {
    return 'adresse refusée : hôte local ou IP';
  }
  return null;
}

function parseUrl(raw: string, base: URL | undefined, reason: string): URL {
  try {
    return new URL(raw, base);
  } catch {
    throw new Error(reason);
  }
}

/** A French reason: ours are French already, undici's network errors are not. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `délai dépassé (${TIMEOUT_MS / 1000} s)`;
  // undici throws TypeError('fetch failed') whose cause carries the system code (ENOTFOUND, ECONNRESET…).
  if (err instanceof TypeError && err.cause !== undefined) {
    const code = typeof err.cause === 'object' && err.cause !== null && 'code' in err.cause ? err.cause.code : null;
    return typeof code === 'string' ? `échec réseau (${code})` : 'échec réseau';
  }
  return err.message;
}

/** Dimensions as displayed, EXIF orientation applied (the browser rendering the video does it too). */
async function displayedSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  try {
    const { width, height } = (await sharp(bytes).metadata()).autoOrient;
    if (width && height) return { width, height };
  } catch {
    // libvips explains in English and on several lines: the reason below is enough.
  }
  throw new Error('image illisible');
}

/** Reads at most maxBytes; null when the body is bigger. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * One GET of one photo. No cookie is sent (fetch has no jar and none is set); redirects
 * are followed by hand so each target passes the same checks. Throws a French reason.
 */
async function fetchImage(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ bytes: Uint8Array; format: LocalPhoto['format'] }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = parseUrl(url, undefined, 'adresse invalide');
  for (let hops = 0; ; hops++) {
    const refused = refusal(current);
    if (refused) throw new Error(refused);
    const res = await fetchFn(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: requestHeaders(DEFAULT_USER_AGENT, ACCEPT_IMAGE),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hops >= MAX_REDIRECTS) throw new Error(`plus de ${MAX_REDIRECTS} redirections`);
      current = parseUrl(location, current, 'redirection vers une adresse invalide');
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) {
      await res.body?.cancel();
      throw new Error(`image trop lourde (${Math.round(declared / 1024 / 1024)} Mo, ${MAX_BYTES / 1024 / 1024} Mo au plus)`);
    }
    const bytes = await readCapped(res, MAX_BYTES);
    if (!bytes) throw new Error(`image trop lourde (plus de ${MAX_BYTES / 1024 / 1024} Mo)`);
    const format = sniffImage(bytes.subarray(0, 16));
    if (!format) throw new Error(`pas une image (${res.headers.get('content-type') ?? 'type inconnu'})`);
    if (!isSupported(format)) throw new Error(`format ${format} non pris en charge`);
    return { bytes, format };
  }
}

async function downloadOne(
  index: number,
  originalUrl: string,
  dir: string,
  fetchFn: typeof fetch,
): Promise<LocalPhoto | PhotoFailure> {
  const variant = largestVariant(originalUrl);
  const attempts = variant === originalUrl ? [originalUrl] : [variant, originalUrl];
  const reasons: string[] = [];
  for (const url of attempts) {
    try {
      const { bytes, format } = await fetchImage(url, fetchFn);
      const { width, height } = await displayedSize(bytes);
      const path = join(dir, `photo-${index}.${EXTENSIONS[format]}`);
      await writeFile(path, bytes);
      return { index, sourceUrl: url, path, width, height, bytes: bytes.byteLength, format };
    } catch (err) {
      const label = attempts.length === 1 ? '' : url === variant ? 'grande taille : ' : 'adresse d’origine : ';
      reasons.push(label + describeError(err));
    }
  }
  return { index, url: originalUrl, reason: reasons.join(' ; ') };
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Downloads the sheet's photos (the first MAX_PHOTOS) into dir as photo-{index}.{ext},
 * each in its biggest known variant, falling back once to the URL as given. A photo
 * that fails, or is not started within DOWNLOAD_BUDGET_MS, is recorded in failures,
 * never thrown.
 */
export async function downloadPhotos(
  sheet: Sheet,
  dir: string,
  deps: DownloadDeps = { fetch },
): Promise<{ photos: LocalPhoto[]; failures: PhotoFailure[] }> {
  await mkdir(dir, { recursive: true });
  const jobs = sheet.photos.slice(0, MAX_PHOTOS).map((photo, index) => ({ index, url: photo.url }));
  const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
  const results = await mapWithConcurrency(jobs, CONCURRENCY, async ({ index, url }): Promise<LocalPhoto | PhotoFailure> =>
    Date.now() > deadline
      ? { index, url, reason: `pas commencée : délai total dépassé (${DOWNLOAD_BUDGET_MS / 1000} s)` }
      : downloadOne(index, url, dir, deps.fetch),
  );
  const photos: LocalPhoto[] = [];
  const failures: PhotoFailure[] = [];
  for (const r of results) {
    if ('reason' in r) failures.push(r);
    else photos.push(r);
  }
  return { photos, failures };
}

// ---------------------------------------------------------------------------
// Selection (Claude, vision)
// ---------------------------------------------------------------------------

/**
 * Long edge of the copies sent to Claude: enough to judge sharpness and framing. An
 * image costs about width x height / 750 tokens: 512x384 is ~262, so 50 candidates
 * (~13k tokens) cost about what 20 did at 768x576 (~590 each, ~11.8k).
 */
const PREVIEW_EDGE = 512;
const PREVIEW_QUALITY = 70;

function selectionSchema(vertical: Sheet['vertical']) {
  const roles: readonly PhotoRole[] = PHOTO_ROLES[vertical];
  return z.object({
    selected: z.array(z.object({ index: z.number().int(), role: z.enum(roles) })),
    rejected: z.array(z.object({ index: z.number().int(), reason: z.string().min(1) })),
  });
}

type SelectionAnswer = z.infer<ReturnType<typeof selectionSchema>>;

type ParsedAnswer = { ok: true; value: SelectionAnswer } | { ok: false; problems: string[] };

/**
 * JSON schema sent to the API, written out because the SDK's zod conversion (0.128.0)
 * turns `enum` into a mere description: here the roles are a constraint the model
 * cannot break. Photo numbers stay plain integers, checked in code, so the schema is
 * the same for every listing of a vertical and its compiled grammar stays cached.
 */
function answerJsonSchema(roles: readonly PhotoRole[]): Record<string, unknown> {
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  return object({
    selected: { type: 'array', items: object({ index: { type: 'integer' }, role: { type: 'string', enum: [...roles] } }) },
    rejected: { type: 'array', items: object({ index: { type: 'integer' }, reason: { type: 'string' } }) },
  });
}

/**
 * Output format for messages.parse, whose parse reports problems instead of throwing
 * (as the SDK's zodOutputFormat does): a throw would lose the response, and with it the
 * usage and the stop reason.
 */
function answerFormat(vertical: Sheet['vertical']) {
  const schema = selectionSchema(vertical);
  return {
    type: 'json_schema' as const,
    schema: answerJsonSchema(PHOTO_ROLES[vertical]),
    parse: (text: string): ParsedAnswer => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, problems: ['la réponse n’est pas un JSON valide'] };
      }
      const result = schema.safeParse(json);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, problems: result.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`) };
    },
  };
}

type Problems = {
  /** The answer cannot be used. */
  hard: string[];
  /** Fewer photos than the minimum: asked once more, then trusted (maybe fewer usable photos). */
  soft: string[];
};

function selectionProblems(answer: SelectionAnswer, indexes: readonly number[], vertical: Sheet['vertical']): Problems {
  const { min, max } = PHOTO_COUNT[vertical];
  const known = new Set(indexes);
  const seen = new Set<number>();
  const hard: string[] = [];
  for (const { index } of [...answer.selected, ...answer.rejected]) {
    if (!known.has(index)) hard.push(`la photo ${index} n’existe pas (photos reçues : ${indexes.join(', ')})`);
    else if (seen.has(index)) hard.push(`la photo ${index} apparaît plusieurs fois`);
    seen.add(index);
  }
  const missing = indexes.filter((i) => !seen.has(i));
  if (missing.length) hard.push(`photos ni gardées ni écartées : ${missing.join(', ')}`);
  if (answer.selected.length > max) hard.push(`${answer.selected.length} photos gardées : ${max} au plus`);
  const soft =
    indexes.length >= min && answer.selected.length < min
      ? [
          `${answer.selected.length} photos gardées sur ${indexes.length} : garde-en au moins ${min} si elles sont utilisables ; si moins de ${min} le sont, renvoie la même sélection`,
        ]
      : [];
  return { hard, soft };
}

async function preview(path: string): Promise<string> {
  const jpeg = await sharp(path)
    .autoOrient()
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: PREVIEW_QUALITY })
    .toBuffer();
  return jpeg.toString('base64');
}

function listingLabel(sheet: Sheet): string {
  return sheet.vertical === 'auto'
    ? `voiture d’occasion, « ${sheet.title} »`
    : `bien immobilier, ${sheet.propertyType} (${sheet.transaction})`;
}

function answerText(message: Anthropic.Message): string {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text || '(réponse vide)';
}

type Usage = Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>;

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

export type SelectDeps = { client: ClaudeClient; model?: string };

/**
 * Asks Claude to discard unusable photos and order the rest by the vertical's roles
 * (CLAUDE.md, "Pipeline vidéo", step 1). The answer is validated; one retry with the
 * problems listed, then a French error. Throws when no photo is usable.
 */
export async function selectPhotos(
  photos: readonly LocalPhoto[],
  sheet: Sheet,
  deps: SelectDeps,
): Promise<{ selection: PhotoSelection; usage: UsageLine }> {
  if (photos.length === 0) throw new Error('Aucune photo téléchargée : impossible de faire la vidéo.');
  const model = deps.model ?? MODELS.photos;
  const vertical = sheet.vertical;

  const sorted = [...photos].sort((a, b) => a.index - b.index);
  const previews = await Promise.allSettled(sorted.map((p) => preview(p.path)));
  const unreadable: PhotoSelection['rejected'] = [];
  const images: { photo: LocalPhoto; data: string }[] = [];
  previews.forEach((r, i) => {
    const photo = sorted[i] as LocalPhoto;
    if (r.status === 'fulfilled') images.push({ photo, data: r.value });
    else unreadable.push({ index: photo.index, reason: 'image illisible' });
  });
  if (images.length === 0) throw new Error('Aucune photo lisible : impossible de faire la vidéo.');

  const indexes = images.map((i) => i.photo.index);
  const content: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: photosUserPrompt({ listing: listingLabel(sheet), indexes }) },
    ...images.flatMap(({ photo, data }): Anthropic.ContentBlockParam[] => [
      { type: 'text', text: `Photo ${photo.index}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
    ]),
    { type: 'text', text: photosFinalPrompt(images.length) },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
  const format = answerFormat(vertical);
  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (let attempt = 1; ; attempt++) {
    const res = await deps.client.messages.parse({
      model,
      max_tokens: 16000,
      system: photosSystemPrompt(vertical),
      messages,
      output_config: { format, effort: 'medium' },
    });
    usage = addUsage(usage, res.usage);
    if (res.stop_reason === 'refusal') throw new Error('Claude a refusé de trier les photos de cette annonce.');
    if (res.stop_reason === 'max_tokens') throw new Error('Tri des photos interrompu : réponse de Claude trop longue (max_tokens).');

    const parsed = res.parsed_output ?? { ok: false, problems: ['aucune réponse JSON'] };
    const problems = parsed.ok ? selectionProblems(parsed.value, indexes, vertical) : { hard: parsed.problems, soft: [] };
    const acceptable = problems.hard.length === 0 && (problems.soft.length === 0 || attempt > 1);
    if (parsed.ok && acceptable) {
      const selection = buildSelection(parsed.value, images.map((i) => i.photo), unreadable, vertical);
      if (selection.selected.length === 0) throw new Error('Aucune photo utilisable dans l’annonce : impossible de faire la vidéo.');
      return { selection, usage: claudeUsageLine('photos', model, usage) };
    }
    if (attempt > 1) {
      throw new Error(`Tri des photos invalide après une relance : ${[...problems.hard, ...problems.soft].join(' ; ')}`);
    }
    messages.push(
      { role: 'assistant', content: answerText(res) },
      { role: 'user', content: photosRetryPrompt([...problems.hard, ...problems.soft]) },
    );
  }
}

/** Kept photos in role order (stable: the model's order within a role is kept). */
function buildSelection(
  answer: SelectionAnswer,
  photos: readonly LocalPhoto[],
  unreadable: PhotoSelection['rejected'],
  vertical: Sheet['vertical'],
): PhotoSelection {
  const byIndex = new Map(photos.map((p) => [p.index, p]));
  const roles: readonly PhotoRole[] = PHOTO_ROLES[vertical];
  const selected: SelectedPhoto[] = answer.selected
    .map(({ index, role }) => ({ ...(byIndex.get(index) as LocalPhoto), role }))
    .sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role));
  const rejected = [...answer.rejected, ...unreadable].sort((a, b) => a.index - b.index);
  return { selected, rejected };
}
