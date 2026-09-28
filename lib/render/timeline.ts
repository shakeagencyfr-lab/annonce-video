import type { SubtitleCue } from '../pipeline/types';
import type { VideoProps } from './props';

/**
 * Pure helpers of the Remotion compositions (remotion/): which photo is on screen
 * when, how it moves, which subtitle and which texts are shown, how loud the music
 * is. No React and no Node API: this file is bundled for the browser by Remotion and
 * tested with vitest.
 */

/** A span of frames, in the shape of Remotion's <Sequence from durationInFrames>. */
export type Slot = { from: number; durationInFrames: number };

/** Crossfade between two consecutive photos. */
export const CROSSFADE_SEC = 0.5;
/** Shortest time a photo stays on screen, crossfades included. */
export const MIN_PHOTO_SEC = 2;
/** Opening card with the title and subtitle. */
export const TITLE_CARD_SEC = 2.5;
/** Closing card (price and contact in the social variant). */
export const END_CARD_SEC = 4;

export const secToFrames = (sec: number, fps: number) => Math.round(sec * fps);

/**
 * One slot per photo shown, in order, covering frames [0, durationInFrames). Each
 * photo starts while the previous one is still on screen, for a crossfade of
 * CROSSFADE_SEC. Photos last at least MIN_PHOTO_SEC: when the video is too short
 * for all of them, the last ones are left out (photos come sorted by priority), so
 * fewer slots than `count` may come back. At least one photo is always shown.
 */
export function photoSchedule(count: number, durationInFrames: number, fps: number): Slot[] {
  if (count <= 0 || durationInFrames <= 0) return [];
  const overlap = secToFrames(CROSSFADE_SEC, fps);
  const minFrames = Math.max(secToFrames(MIN_PHOTO_SEC, fps), overlap + 1);
  const fit = Math.floor((durationInFrames - overlap) / (minFrames - overlap));
  const shown = Math.min(count, Math.max(1, fit));
  if (shown === 1) return [{ from: 0, durationInFrames }];

  // Photo i starts at starts[i] and lasts until `overlap` frames after the next start.
  const step = (durationInFrames - overlap) / shown;
  const starts = Array.from({ length: shown }, (_, i) => Math.round(i * step));
  return starts.map((from, i) => {
    const next = starts[i + 1];
    const end = next === undefined ? durationInFrames : next + overlap;
    return { from, durationInFrames: end - from };
  });
}

/**
 * The photo track: photos scheduled over the time before the end card, plus the
 * crossfade into its veil, so that none is only ever seen under the card. The last
 * photo then holds under the card until the end of the video.
 */
export function photoTrackSchedule(count: number, durationInFrames: number, fps: number): Slot[] {
  const until = Math.min(durationInFrames, endCardFrom(durationInFrames, fps) + secToFrames(CROSSFADE_SEC, fps));
  const slots = photoSchedule(count, until, fps);
  const last = slots.at(-1);
  if (!last) return slots;
  return [...slots.slice(0, -1), { from: last.from, durationInFrames: durationInFrames - last.from }];
}

/** Opacity of a photo fading in over the previous one, from its first frame. */
export function fadeInOpacity(frameInSlot: number, fadeFrames: number): number {
  if (fadeFrames <= 0) return 1;
  return Math.min(1, Math.max(0, frameInSlot / fadeFrames));
}

/**
 * Slow zoom of a photo, in or out between 1.0 and its peak (1.1 by default), around a
 * focus point given in percent of the photo (CSS transform-origin). A scale of at
 * least 1 around a point inside the photo never uncovers its edges. The view drifts
 * toward the focus point on a zoom in and away from it on a zoom out, so drift =
 * (originX - 50) * (toScale - fromScale) alternates left and right from one photo to
 * the next.
 */
export type KenBurns = { fromScale: number; toScale: number; originX: number; originY: number };

/** Peak of the slow zoom on a photo sharp enough for it. */
export const KEN_BURNS_PEAK = 1.1;

const KEN_BURNS: readonly KenBurns[] = [
  { fromScale: 1, toScale: KEN_BURNS_PEAK, originX: 30, originY: 45 },
  { fromScale: 1, toScale: KEN_BURNS_PEAK, originX: 70, originY: 55 },
  { fromScale: KEN_BURNS_PEAK, toScale: 1, originX: 70, originY: 45 },
  { fromScale: KEN_BURNS_PEAK, toScale: 1, originX: 30, originY: 55 },
];

/** Deterministic Ken Burns move of the photo at a position in the video, up to `peak`. */
export function kenBurns(indexSeed: number, peak: number = KEN_BURNS_PEAK): KenBurns {
  const i = ((Math.trunc(indexSeed) % KEN_BURNS.length) + KEN_BURNS.length) % KEN_BURNS.length;
  const move = KEN_BURNS[i] ?? KEN_BURNS[0]!;
  const scale = (s: number) => (s > 1 ? peak : 1);
  return { ...move, fromScale: scale(move.fromScale), toScale: scale(move.toScale) };
}

/**
 * Largest enlargement of a source photo, zoom included. Leboncoin serves 800×600 at
 * most: covered in 16:9, it is already drawn 2.4 times its size, and the full zoom
 * would take it to 2.64 times, visibly soft.
 */
export const MAX_UPSCALE = 2.5;
/** Smallest zoom peak, so that a low-resolution photo still moves a little. */
export const MIN_ZOOM_PEAK = 1.02;

/**
 * Peak of the slow zoom for a photo drawn at `baseScale` times its size: the full
 * KEN_BURNS_PEAK while the enlargement stays within MAX_UPSCALE, less on small photos.
 */
export function zoomPeak(baseScale: number): number {
  if (!(baseScale > 0)) return KEN_BURNS_PEAK;
  return Math.min(KEN_BURNS_PEAK, Math.max(MIN_ZOOM_PEAK, MAX_UPSCALE / baseScale));
}

/** Scale at a point of the move, progress from 0 (slot start) to 1 (slot end). */
export function kenBurnsScale(move: KenBurns, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return move.fromScale + (move.toScale - move.fromScale) * p;
}

/** First frame of the end card; never before the title card is over. */
export function endCardFrom(durationInFrames: number, fps: number): number {
  const titleEnd = Math.min(secToFrames(TITLE_CARD_SEC, fps), durationInFrames);
  return Math.max(titleEnd, durationInFrames - secToFrames(END_CARD_SEC, fps));
}

/** The subtitle cue on screen at a frame, if any (cues are in seconds, end excluded). */
export function cueAtFrame(cues: readonly SubtitleCue[], frame: number, fps: number): SubtitleCue | undefined {
  const t = frame / fps;
  return cues.find((cue) => cue.start <= t && t < cue.end);
}

/** Largest share of a photo that "cover" may crop before it is shown whole instead. */
export const MAX_COVER_CROP = 0.3;

type Size = { width: number; height: number };

/**
 * "cover" fills the frame and crops what overflows; "contain" shows the whole photo
 * over a blurred copy of itself. A landscape car photo in 9:16 is contained (cover
 * would crop most of the car); a 4:3 or 3:2 photo in 16:9 is covered.
 */
export function photoFit(photo: Size, frame: Size): 'cover' | 'contain' {
  if (photo.width <= 0 || photo.height <= 0) return 'cover';
  const ratio = photo.width / photo.height / (frame.width / frame.height);
  const kept = Math.min(ratio, 1 / ratio);
  return 1 - kept <= MAX_COVER_CROP ? 'cover' : 'contain';
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where a contained photo sits: centered, as large as the frame allows. Its Ken Burns
 * move is clipped to this box (remotion/components/Photos.tsx) instead of shrinking
 * the box to leave room for the zoom, so a landscape photo spans the whole width of
 * the 9:16 frame.
 */
export function containedBox(photo: Size, frame: Size): Box {
  if (photo.width <= 0 || photo.height <= 0) return { left: 0, top: 0, ...frame };
  const fit = Math.min(frame.width / photo.width, frame.height / photo.height);
  const width = photo.width * fit;
  const height = photo.height * fit;
  return { left: (frame.width - width) / 2, top: (frame.height - height) / 2, width, height };
}

/** How many times its own size a photo is drawn before its zoom, covered or contained. */
export function photoBaseScale(photo: Size, frame: Size): number {
  if (photo.width <= 0 || photo.height <= 0) return 1;
  const x = frame.width / photo.width;
  const y = frame.height / photo.height;
  return photoFit(photo, frame) === 'cover' ? Math.max(x, y) : Math.min(x, y);
}

/** Background music level under the voice. */
export const MUSIC_VOLUME = 0.12;
/** The music fades out over the end of the video instead of stopping dead. */
export const MUSIC_FADE_OUT_SEC = 1;

/** Music volume at a frame of the video (not of the music file, which may loop). */
export function musicVolume(frame: number, durationInFrames: number, fps: number): number {
  const fade = Math.max(1, secToFrames(MUSIC_FADE_OUT_SEC, fps));
  return MUSIC_VOLUME * Math.min(1, Math.max(0, (durationInFrames - frame) / fade));
}

export type ScreenTexts = {
  title: string;
  subtitle?: string;
  price?: string;
  contact?: string;
  dpe?: NonNullable<VideoProps['dpe']>;
};

/**
 * A text as drawn on screen. The data writes « 41 000 » with a narrow no-break space
 * (U+202F), which the voice and the fact check rely on, but the Latin subset of Inter
 * has no glyph for it and the fallback is nearly invisible at 1080p: a no-break space
 * (U+00A0) keeps the digits together with a visible gap. An apostrophe between two
 * letters becomes the typographic one used by the other texts (« l’annonce »).
 */
export function displayText(text: string): string {
  return text.replace(/\u202F/g, '\u00A0').replace(/(\p{L})'(?=\p{L})/gu, '$1’');
}

const nonBlank = (text: string | undefined) => (text?.trim() ? displayText(text) : undefined);

/**
 * What the video writes on screen, ready to draw (displayText). The listing variant
 * never shows the price nor the contact, whatever the props hold (CLAUDE.md, "Modèles
 * vidéo"); the DPE class read from the listing is shown on immo videos only (rule 5).
 * Blank texts are left out.
 */
export function screenTexts(props: Pick<VideoProps, 'variant' | 'vertical' | 'overlays' | 'dpe'>): ScreenTexts {
  const social = props.variant === 'social';
  const texts: ScreenTexts = { title: displayText(props.overlays.title) };
  const subtitle = nonBlank(props.overlays.subtitle);
  const price = social ? nonBlank(props.overlays.price) : undefined;
  const contact = social ? nonBlank(props.overlays.contact) : undefined;
  if (subtitle) texts.subtitle = subtitle;
  if (price) texts.price = price;
  if (contact) texts.contact = contact;
  if (props.vertical === 'immo' && props.dpe) texts.dpe = props.dpe;
  return texts;
}
