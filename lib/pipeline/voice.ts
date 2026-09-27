import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ELEVENLABS_MODEL } from '../config';
import { ttsUsageLine } from '../costs';
import type { UsageLine, VideoScript, Voiceover, WordTiming } from './types';

/**
 * Voice-over with ElevenLabs (CLAUDE.md, "Pipeline vidéo", step 3): the endpoint with
 * timestamps gives the start and end of every character, from which the subtitles are
 * timed. REST only, no SDK. The API key is sent in a header and never appears in an
 * error message or a log (rule 8).
 */

const API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const OUTPUT_FORMAT = 'mp3_44100_128';
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };
/** Models that accept language_code; eleven_multilingual_v2 detects the language itself. */
const LANGUAGE_CODE_MODELS = new Set(['eleven_turbo_v2_5', 'eleven_flash_v2_5']);
const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
/** Silence kept after the last word. */
const TAIL_SEC = 0.4;
const MAX_DETAIL_CHARS = 300;

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Spaces between words. Non-breaking spaces stay inside a word: « 68 000 », « Prix : ». */
const BREAKING_SPACE = /^[^\S  ]+$/;
/** Opening marks, shown with the next word: « Caméra ». */
const OPENING = /^[«“‘([{]+$/u;
/** Marks and units shown with the previous word: « compteur . », « Prix : », « 15 990 € ». */
const CLOSING = /^[\p{P}\p{Sc}%°]+$/u;
/**
 * Digits of a French number written with plain spaces: « 68 000 », also after an
 * opening mark: « (68 000 km) ». Not after a letter, a digit or a decimal separator.
 */
const NUMBER_HEAD = /(?:^|[^\p{L}\p{N},.])\d{1,3}(?:[\u00A0\u202F]\d{3})*$/u;
const NUMBER_GROUP = /^\d{3}(?!\d)/;
const NBSP = ' ';

export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/**
 * Words and their timings from a character alignment. Words are split on spaces, not
 * on non-breaking ones. What a line break must not separate from its word (a French
 * « : » or « ! », a currency sign, the groups of a number) is joined to it with a
 * non-breaking space, so a subtitle never starts with it.
 */
export function wordsFromAlignment(alignment: Alignment): WordTiming[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  const tokens: WordTiming[] = [];
  let current: WordTiming | undefined;
  for (const [i, ch] of characters.entries()) {
    if (BREAKING_SPACE.test(ch)) {
      current = undefined;
      continue;
    }
    const start = starts[i] ?? 0;
    const end = Math.max(ends[i] ?? start, start);
    if (current) {
      current.word += ch;
      current.end = Math.max(current.end, end);
    } else {
      current = { word: ch, start, end };
      tokens.push(current);
    }
  }
  return joinTokens(tokens);
}

function joinTokens(tokens: WordTiming[]): WordTiming[] {
  const words: WordTiming[] = [];
  let opening: WordTiming | undefined;
  for (const token of tokens) {
    const prev = words.at(-1);
    if (OPENING.test(token.word)) {
      opening = opening ? joined(opening, token) : token;
    } else if (opening) {
      words.push(joined(opening, token));
      opening = undefined;
    } else if (prev && (CLOSING.test(token.word) || (NUMBER_HEAD.test(prev.word) && NUMBER_GROUP.test(token.word)))) {
      words[words.length - 1] = joined(prev, token);
    } else {
      words.push({ ...token });
    }
  }
  if (opening) words.push(opening);
  return words;
}

function joined(a: WordTiming, b: WordTiming): WordTiming {
  return { word: `${a.word}${NBSP}${b.word}`, start: a.start, end: Math.max(a.end, b.end) };
}

/** Spoken text: the segments in script order (hook, points, call to action). */
export function voiceText(script: VideoScript): string {
  return script.segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');
}

const roundMs = (sec: number) => Math.round(sec * 1000) / 1000;

function durationOf(words: WordTiming[]): number {
  return roundMs((words.at(-1)?.end ?? 0) + TAIL_SEC);
}

/**
 * Voice-over without audio, words evenly timed: for the offline mode (silent video)
 * and tests. Same word split as the real voice-over.
 */
export function estimateVoiceover(script: VideoScript, opts: { wordsPerSecond?: number } = {}): Voiceover {
  const wordsPerSecond = opts.wordsPerSecond ?? 2.5;
  if (!(wordsPerSecond > 0)) throw new Error(`wordsPerSecond doit être positif, reçu ${wordsPerSecond}`);
  const text = voiceText(script);
  const characters = [...text];
  const zeros = characters.map(() => 0);
  const step = 1 / wordsPerSecond;
  const words = wordsFromAlignment({
    characters,
    character_start_times_seconds: zeros,
    character_end_times_seconds: zeros,
  }).map((w, i) => ({ word: w.word, start: roundMs(i * step), end: roundMs((i + 1) * step) }));
  return { variant: script.variant, audioPath: '', durationSec: durationOf(words), words, characters: text.length };
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

/** An empty alignment is accepted here: synthesize() then falls back to the other one. */
const AlignmentSchema = z
  .object({
    characters: z.array(z.string()),
    character_start_times_seconds: z.array(z.number().nonnegative()),
    character_end_times_seconds: z.array(z.number().nonnegative()),
  })
  .refine(
    (a) =>
      a.character_start_times_seconds.length === a.characters.length &&
      a.character_end_times_seconds.length === a.characters.length,
    { message: 'caractères et temps de longueurs différentes' },
  );

export const TimestampsResponseSchema = z
  .object({
    audio_base64: z.base64().min(1),
    alignment: AlignmentSchema.nullish(),
    normalized_alignment: AlignmentSchema.nullish(),
  })
  .refine((r) => r.alignment || r.normalized_alignment, { message: 'aucun alignement', path: ['alignment'] });

/**
 * Error bodies: { detail: { status, message } }, or { detail: { code, message } } in the
 * newer format, or FastAPI's list of validation errors on a 422.
 */
const ErrorBodySchema = z.object({
  detail: z.union([
    z.string(),
    z.object({ status: z.string().optional(), code: z.string().optional(), message: z.string().optional() }),
    z.array(z.object({ msg: z.string(), loc: z.array(z.union([z.string(), z.number()])).optional() })),
  ]),
});

export type SynthesizeDeps = {
  apiKey: string;
  voiceId: string;
  /** Folder of the render's public files: the audio is written there as voice-{variant}.mp3. */
  outDir: string;
  fetch?: typeof fetch;
  model?: string;
  /** Wait before the single retry on 429, 5xx or a network error. */
  retryDelayMs?: number;
};

/** Removes the key from any text that could reach an error message (rule 8). */
function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

function detailOf(body: unknown): { status?: string; message?: string } {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return {};
  const { detail } = parsed.data;
  if (typeof detail === 'string') return { message: detail };
  if (Array.isArray(detail)) {
    return { message: detail.map((d) => (d.loc?.length ? `${d.loc.at(-1)} : ${d.msg}` : d.msg)).join(' ; ') };
  }
  const code = detail.status ?? detail.code;
  return { status: code, message: detail.message ?? code };
}

function httpError(status: number, body: unknown, retried: boolean): string {
  const detail = detailOf(body);
  const message = detail.message?.slice(0, MAX_DETAIL_CHARS);
  const suffix = message ? ` : ${message}` : '';
  if (status === 402 || /quota|credit/i.test(detail.status ?? '')) {
    return `quota ElevenLabs épuisé : recharger les crédits ou changer de formule${suffix}`;
  }
  // A 401 also covers a key without the text-to-speech permission: keep the API detail.
  if (status === 401) return `clé ElevenLabs invalide (vérifier ELEVENLABS_API_KEY)${suffix}`;
  if (detail.status === 'voice_not_found') {
    return `voix ElevenLabs introuvable (vérifier ELEVENLABS_VOICE_ID_FR)${suffix}`;
  }
  if (status === 422) return `texte ou réglages refusés par ElevenLabs${suffix}`;
  if (status === 429 || status >= 500) {
    return `ElevenLabs indisponible (HTTP ${status})${retried ? ' après une nouvelle tentative' : ''}${suffix}`;
  }
  return `ElevenLabs a répondu HTTP ${status}${suffix}`;
}

const isRetryable = (status: number) => status === 429 || status >= 500;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `délai dépassé (${TIMEOUT_MS / 1000} s)`;
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.message}${cause}`;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One POST, retried once after a delay on 429, 5xx or a network error (including a
 * body cut off or timed out while being read).
 */
async function requestTimestamps(
  text: string,
  language: string,
  deps: SynthesizeDeps & { model: string },
): Promise<z.infer<typeof TimestampsResponseSchema>> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${API_URL}/${encodeURIComponent(deps.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
  const body = JSON.stringify({
    text,
    model_id: deps.model,
    voice_settings: VOICE_SETTINGS,
    ...(LANGUAGE_CODE_MODELS.has(deps.model) ? { language_code: language } : {}),
  });
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    const retried = attempt > 1;
    let res: Response;
    let raw: string;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': deps.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      raw = await res.text();
    } catch (err) {
      if (attempt < maxAttempts) {
        await wait(deps.retryDelayMs ?? RETRY_DELAY_MS);
        continue;
      }
      throw new Error(`ElevenLabs injoignable${retried ? ' après une nouvelle tentative' : ''} : ${describeError(err)}`);
    }
    const json = parseJson(raw);
    if (!res.ok) {
      if (isRetryable(res.status) && attempt < maxAttempts) {
        await wait(deps.retryDelayMs ?? RETRY_DELAY_MS);
        continue;
      }
      throw new Error(httpError(res.status, json, retried));
    }
    if (json === undefined) throw new Error('réponse ElevenLabs illisible (JSON attendu)');
    const parsed = TimestampsResponseSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'racine'} : ${i.message}`)
        .join(' ; ');
      throw new Error(`réponse ElevenLabs inattendue (${issues})`);
    }
    return parsed.data;
  }
}

/**
 * Reads the script aloud with ElevenLabs and writes outDir/voice-{variant}.mp3.
 * Word timings come from the alignment of the text as sent (numbers stay written
 * « 68 000 », as in the subtitles), or from the normalized alignment if absent or empty.
 */
export async function synthesize(
  script: VideoScript,
  deps: SynthesizeDeps,
): Promise<{ voiceover: Voiceover; usage: UsageLine }> {
  const model = deps.model ?? ELEVENLABS_MODEL;
  const text = voiceText(script);
  const apiKey = deps.apiKey.trim();
  const voiceId = deps.voiceId.trim();
  if (!text) throw new Error('script vide : rien à lire');
  if (!voiceId) throw new Error('voix ElevenLabs manquante (ELEVENLABS_VOICE_ID_FR)');
  if (!apiKey) throw new Error('clé ElevenLabs manquante (ELEVENLABS_API_KEY)');
  // Before the paid call, so a bad price setting fails without spending characters.
  const usage = ttsUsageLine(text.length, model);

  let response: z.infer<typeof TimestampsResponseSchema>;
  try {
    response = await requestTimestamps(text, script.language, { ...deps, apiKey, voiceId, model });
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), apiKey));
  }

  const words = [response.alignment, response.normalized_alignment]
    .map((alignment) => (alignment ? wordsFromAlignment(alignment) : []))
    .find((w) => w.length > 0);
  if (!words) throw new Error('réponse ElevenLabs sans aucun mot aligné');
  const audio = Buffer.from(response.audio_base64, 'base64');
  if (audio.byteLength === 0) throw new Error('réponse ElevenLabs sans audio');

  await mkdir(deps.outDir, { recursive: true });
  const audioPath = join(deps.outDir, `voice-${script.variant}.mp3`);
  await writeFile(audioPath, audio);

  return {
    voiceover: { variant: script.variant, audioPath, durationSec: durationOf(words), words, characters: text.length },
    usage,
  };
}
