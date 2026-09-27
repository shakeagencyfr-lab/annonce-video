import type Anthropic from '@anthropic-ai/sdk';
import type { Sheet } from '../sheet';

/**
 * Contracts between the pipeline steps (CLAUDE.md, "Pipeline vidéo"):
 * sheet -> photos -> script -> voice -> render. Each step is a module under
 * lib/pipeline/ that takes its dependencies (Claude client, fetch, paths) as
 * arguments so it can be tested without network.
 */

/** V1 is French; German, Italian and Dutch must plug in without touching the templates. */
export type Language = 'fr' | 'de' | 'it' | 'nl';

export type Format = '9x16' | '16x9';

/**
 * The two script variants. "social" (9:16, networks) may state the price and the
 * contact; "listing" (16:9, pasted in the listing as a YouTube link) never states
 * the price nor a phone number.
 */
export type Variant = 'social' | 'listing';

export const FORMAT_OF_VARIANT: Record<Variant, Format> = { social: '9x16', listing: '16x9' };

/** Only the Messages API surface the pipeline uses, so tests can pass a fake. */
export type ClaudeClient = Pick<Anthropic, 'messages'>;

/** One photo of the sheet, downloaded to disk. `index` is its position in sheet.photos. */
export type LocalPhoto = {
  index: number;
  sourceUrl: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
  format: 'jpeg' | 'png' | 'webp' | 'avif' | 'gif';
};

/** Roles used to order photos, per vertical (CLAUDE.md, "Modèles vidéo"). */
export const PHOTO_ROLES = {
  auto: ['trois-quarts avant', 'profil', 'arrière', 'intérieur', 'tableau de bord', 'détail', 'autre'],
  immo: ['façade ou vue', 'séjour', 'cuisine', 'chambre', 'salle de bain', 'extérieur', 'plan', 'autre'],
} as const;

export type PhotoRole = (typeof PHOTO_ROLES)[keyof typeof PHOTO_ROLES][number];

export type SelectedPhoto = LocalPhoto & { role: PhotoRole };

export type PhotoSelection = {
  /** Kept photos, in video order. */
  selected: SelectedPhoto[];
  rejected: { index: number; reason: string }[];
};

/** Photos kept per vertical. */
export const PHOTO_COUNT = { auto: { min: 8, max: 10 }, immo: { min: 10, max: 14 } } as const;

/** Target voice-over length per vertical, in seconds. */
export const DURATION_SEC = { auto: { min: 30, max: 40 }, immo: { min: 45, max: 60 } } as const;

/**
 * One spoken sentence or group. `facts` lists the sheet fields it relies on
 * (e.g. "mileageKm", "equipment[2]"), which the fact check verifies (rule 3).
 */
export type ScriptSegment = {
  kind: 'hook' | 'point' | 'cta';
  text: string;
  facts: string[];
};

export type VideoScript = {
  variant: Variant;
  language: Language;
  segments: ScriptSegment[];
  /** On-screen texts. price and contact exist only in the "social" variant. */
  overlays: { title: string; subtitle?: string; price?: string; contact?: string };
};

export type WordTiming = { word: string; start: number; end: number };

export type Voiceover = {
  variant: Variant;
  audioPath: string;
  durationSec: number;
  words: WordTiming[];
  /** Characters billed by the TTS provider. */
  characters: number;
};

/** A subtitle line shown from start to end (seconds), built from word timings. */
export type SubtitleCue = { text: string; start: number; end: number };

/** Cost line of one step (CLAUDE.md, table video_costs). */
export type UsageLine = {
  step: 'lecture' | 'photos' | 'script' | 'voix' | 'rendu';
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  ttsCharacters?: number;
  costUsd: number;
};

export type PipelineContext = {
  sheet: Sheet;
  language: Language;
  workDir: string;
};
