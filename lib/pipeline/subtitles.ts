import type { Format, SubtitleCue, WordTiming } from './types';

/**
 * Burned-in subtitles (CLAUDE.md, "Pipeline vidéo", step 3): the voice-over words
 * grouped into one-line cues timed on the ElevenLabs timestamps. Pure and deterministic.
 */

/** Characters per line that stay readable at the subtitle size of each format. */
export const SUBTITLE_MAX_CHARS: Record<Format, number> = { '9x16': 28, '16x9': 42 };
/** Longest time a cue stays on screen. */
export const SUBTITLE_MAX_SEC = 3.2;
/** A shorter gap before the next cue is closed, to avoid a flicker. */
export const SUBTITLE_MERGE_GAP_SEC = 0.25;
/** A line is cut after a comma only if what comes before is at least this share of a line. */
const MIN_SHARE_BEFORE_COMMA = 0.4;

/** End of sentence: always ends the cue. Closing quotes or brackets may follow. */
const SENTENCE_END = /[.!?…][»”’")\]]*$/u;
/** Pause inside a sentence: preferred place to cut a line that is too long. */
const PAUSE = /[,;:—–][»”’")\]]*$/u;

export type CueOptions = {
  maxChars?: number;
  maxDurationSec?: number;
  mergeGapSec?: number;
};

const lineText = (words: readonly WordTiming[]) => words.map((w) => w.word).join(' ');

/**
 * Where to cut a line that cannot take the next word: after its last pause if the
 * part before is long enough; else before its last word when the next word ends the
 * sentence, so that word is not left alone on its cue; else after its last word.
 * Returns the count of words kept on the line.
 */
function cutIndex(
  line: readonly WordTiming[],
  next: WordTiming,
  minChars: number,
  fits: (words: readonly WordTiming[]) => boolean,
): number {
  for (let k = line.length - 2; k >= 0; k--) {
    const word = line[k];
    if (word && PAUSE.test(word.word) && lineText(line.slice(0, k + 1)).length >= minChars) return k + 1;
  }
  const last = line.at(-1);
  if (line.length >= 3 && last && SENTENCE_END.test(next.word) && fits([last, next])) return line.length - 1;
  return line.length;
}

/** Groups consecutive words into one-line cues, then times them without overlap. */
export function buildCues(words: readonly WordTiming[], format: Format, opts: CueOptions = {}): SubtitleCue[] {
  const maxChars = opts.maxChars ?? SUBTITLE_MAX_CHARS[format];
  const maxSec = opts.maxDurationSec ?? SUBTITLE_MAX_SEC;
  const gapSec = opts.mergeGapSec ?? SUBTITLE_MERGE_GAP_SEC;
  const minChars = Math.round(maxChars * MIN_SHARE_BEFORE_COMMA);

  const fits = (line: readonly WordTiming[]) => {
    const first = line[0];
    const last = line.at(-1);
    if (!first || !last || line.length === 1) return true;
    return lineText(line).length <= maxChars && last.end - first.start <= maxSec;
  };

  const lines: WordTiming[][] = [];
  let line: WordTiming[] = [];
  for (const raw of words) {
    const word = raw.word.trim();
    if (!word) continue;
    const w = { ...raw, word };
    while (line.length > 0 && !fits([...line, w])) {
      const keep = cutIndex(line, w, minChars, fits);
      lines.push(line.slice(0, keep));
      line = line.slice(keep);
    }
    line.push(w);
    if (SENTENCE_END.test(word)) {
      lines.push(line);
      line = [];
    }
  }
  if (line.length > 0) lines.push(line);

  const spans = lines.map((l) => ({ text: lineText(l).trim(), start: l[0]?.start ?? 0, end: l.at(-1)?.end ?? 0 }));
  const cues: SubtitleCue[] = [];
  for (const [i, span] of spans.entries()) {
    const start = Math.max(span.start, cues.at(-1)?.end ?? 0);
    let end = Math.max(span.end, start);
    const next = spans[i + 1];
    if (next) {
      if (next.start < end) end = Math.max(next.start, start);
      else if (next.start - end < gapSec) end = Math.max(end, Math.min(next.start, start + maxSec));
    }
    cues.push({ text: span.text, start, end });
  }
  return cues;
}
