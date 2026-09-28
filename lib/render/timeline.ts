import type { SubtitleCue, WordTiming } from '../pipeline/types';
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

/** Cubic ease in and out, for the push from one photo to the next. */
export function easeInOutCubic(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Horizontal position of a photo in its frame, in frame widths: the next photo pushes
 * the current one out to the left. A photo that `enters` comes in from the right (1 to
 * 0) over its first `transitionFrames`; one that `exits` leaves to the left (0 to -1)
 * over its last ones. With photoSchedule() the two moves overlap exactly, so the
 * photos stay side by side.
 */
export function pushOffset(
  frameInSlot: number,
  slotFrames: number,
  transitionFrames: number,
  opts: { enters: boolean; exits: boolean },
): number {
  if (transitionFrames <= 0) return 0;
  if (opts.enters && frameInSlot < transitionFrames) return 1 - easeInOutCubic(frameInSlot / transitionFrames);
  const exitFrom = slotFrames - transitionFrames;
  if (opts.exits && frameInSlot >= exitFrom) return -easeInOutCubic((frameInSlot - exitFrom) / transitionFrames);
  return 0;
}

/** Opacity of a photo fading in over the previous one, from its first frame. */
export function fadeInOpacity(frameInSlot: number, fadeFrames: number): number {
  if (fadeFrames <= 0) return 1;
  return Math.min(1, Math.max(0, frameInSlot / fadeFrames));
}

/**
 * Slow zoom of a photo, in or out between 1.0 and 1.1, around a focus point given in
 * percent of the photo (CSS transform-origin). A scale of at least 1 around a point
 * inside the photo never uncovers its edges. The view drifts toward the focus point
 * on a zoom in and away from it on a zoom out, so drift = (originX - 50) *
 * (toScale - fromScale) alternates left and right from one photo to the next.
 */
export type KenBurns = { fromScale: number; toScale: number; originX: number; originY: number };

const KEN_BURNS: readonly KenBurns[] = [
  { fromScale: 1, toScale: 1.1, originX: 30, originY: 45 },
  { fromScale: 1, toScale: 1.1, originX: 70, originY: 55 },
  { fromScale: 1.1, toScale: 1, originX: 70, originY: 45 },
  { fromScale: 1.1, toScale: 1, originX: 30, originY: 55 },
];

/** Deterministic Ken Burns move of the photo at a position in the video. */
export function kenBurns(indexSeed: number): KenBurns {
  const i = ((Math.trunc(indexSeed) % KEN_BURNS.length) + KEN_BURNS.length) % KEN_BURNS.length;
  return KEN_BURNS[i] ?? KEN_BURNS[0]!;
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

/** Index of the word being spoken at `timeSec` (the last one started), -1 before the first. */
export function activeWordIndex(words: readonly WordTiming[], timeSec: number): number {
  let active = -1;
  for (const [i, w] of words.entries()) {
    if (w.start <= timeSec) active = i;
    else break;
  }
  return active;
}

/**
 * Text as drawn on screen: the narrow no-break space of French numbers (68 000 km,
 * 15 990 €) is almost invisible at video sizes, so it becomes a normal-width one.
 */
export function displayText(text: string): string {
  return text.replace(/\u202F/g, '\u00A0');
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
 * Where a contained photo sits: centered, as large as possible while its Ken Burns
 * move, scaled around its origin (percent of this box), never pushes an edge out of
 * the frame. A contained photo is thus never cropped, even at the top of its zoom.
 */
export function containedBox(photo: Size, frame: Size, move: KenBurns): Box {
  if (photo.width <= 0 || photo.height <= 0) return { left: 0, top: 0, ...frame };
  const grow = Math.max(move.fromScale, move.toScale, 1) - 1;
  // A centered box of size s scaled by 1 + grow around a point at share o of it
  // spreads by o·grow·s on one side and (1 − o)·grow·s on the other; each must fit
  // in the margin (frame − s) / 2, so s ≤ frame / (1 + 2·grow·max(o, 1 − o)).
  const spread = (originPercent: number) => 1 + (2 * grow * Math.max(originPercent, 100 - originPercent)) / 100;
  const fit = Math.min(
    frame.width / (photo.width * spread(move.originX)),
    frame.height / (photo.height * spread(move.originY)),
  );
  const width = photo.width * fit;
  const height = photo.height * fit;
  return { left: (frame.width - width) / 2, top: (frame.height - height) / 2, width, height };
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

const nonBlank = (text: string | undefined) => (text?.trim() ? text : undefined);

/**
 * What the video writes on screen. The listing variant never shows the price nor the
 * contact, whatever the props hold (CLAUDE.md, "Modèles vidéo"); the DPE class read
 * from the listing is shown on immo videos only (rule 5). Blank texts are left out.
 */
export function screenTexts(props: Pick<VideoProps, 'variant' | 'vertical' | 'overlays' | 'dpe'>): ScreenTexts {
  const social = props.variant === 'social';
  const texts: ScreenTexts = { title: props.overlays.title };
  const subtitle = nonBlank(props.overlays.subtitle);
  const price = social ? nonBlank(props.overlays.price) : undefined;
  const contact = social ? nonBlank(props.overlays.contact) : undefined;
  if (subtitle) texts.subtitle = subtitle;
  if (price) texts.price = price;
  if (contact) texts.contact = contact;
  if (props.vertical === 'immo' && props.dpe) texts.dpe = props.dpe;
  return texts;
}
