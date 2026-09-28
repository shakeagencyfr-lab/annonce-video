import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SubtitleCue } from '../../lib/pipeline/types';
import { activeWordIndex, cueAtFrame, displayText } from '../../lib/render/timeline';
import { COLORS, clamp, useLayout } from './layout';

/**
 * Burned-in subtitles in large bold type, the word being spoken in the accent color,
 * timed on the voice-over: on the lower part of the photo, then under the end card's
 * block, across the whole width, from `endFrom`.
 */
export function Captions({ cues, endFrom }: { cues: SubtitleCue[]; endFrom: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const cue = cueAtFrame(cues, frame, fps);
  if (!cue) return null;

  const since = frame - Math.floor(cue.start * fps);
  const scale = interpolate(since, [0, 4], [0.9, 1], clamp);
  const opacity = interpolate(since, [0, 3], [0, 1], clamp);
  const words = cue.words?.length ? cue.words : [{ word: cue.text, start: cue.start, end: cue.end }];
  const active = activeWordIndex(words, frame / fps);
  const captions =
    frame < endFrom
      ? layout.captions
      : {
          ...layout.captions,
          left: layout.sideMargin,
          width: layout.width - 2 * layout.sideMargin,
          centerY: layout.endCard.captionsY,
        };
  return (
    <div
      style={{
        position: 'absolute',
        left: captions.left,
        width: captions.width,
        top: captions.centerY,
        transform: `translateY(-50%) scale(${scale})`,
        opacity,
        textAlign: 'center',
        fontSize: captions.fontSize,
        fontWeight: 900,
        lineHeight: 1.16,
        letterSpacing: '-0.01em',
        textShadow: '0 4px 0 rgba(0,0,0,0.5), 0 0 22px rgba(0,0,0,0.65)',
      }}
    >
      {words.map((w, i) => (
        <span key={i} style={{ color: i === active ? COLORS.accent : COLORS.text }}>
          {displayText(w.word)}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </div>
  );
}
