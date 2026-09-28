import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SubtitleCue } from '../../lib/pipeline/types';
import { cueAtFrame, displayText } from '../../lib/render/timeline';
import { COLORS, clamp, fitLineFontSize, useLayout } from './layout';

/** Horizontal padding of the subtitle box, in em. */
const PADDING_EM = 0.42;

/**
 * Burned-in subtitle of the current cue, white on a dark box, with a short pop-in.
 * Always one line: cues are cut to fit (lib/pipeline/subtitles.ts), and a cue that
 * would still overflow, such as a single long word, is drawn smaller.
 */
export function Subtitles({ cues }: { cues: SubtitleCue[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const cue = cueAtFrame(cues, frame, fps);
  if (!cue) return null;

  const text = displayText(cue.text);
  const boxWidth = layout.width - layout.sideMargin - layout.textRight;
  const since = frame - Math.floor(cue.start * fps);
  const scale = interpolate(since, [0, 5], [0.92, 1], clamp);
  const opacity = interpolate(since, [0, 3], [0, 1], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: layout.sideMargin,
        right: layout.textRight,
        top: layout.subtitleCenter,
        transform: `translateY(-50%) scale(${scale})`,
        opacity,
        textAlign: 'center',
      }}
    >
      <span
        style={{
          fontSize: fitLineFontSize(text, layout.fontSize.subtitles, boxWidth, PADDING_EM),
          fontWeight: 800,
          lineHeight: 1.45,
          whiteSpace: 'nowrap',
          color: COLORS.text,
          backgroundColor: 'rgba(10, 11, 14, 0.78)',
          padding: `0.1em ${PADDING_EM}em`,
          borderRadius: '0.22em',
        }}
      >
        {text}
      </span>
    </div>
  );
}
