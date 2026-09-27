import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SubtitleCue } from '../../lib/pipeline/types';
import { cueAtFrame } from '../../lib/render/timeline';
import { COLORS, clamp, useLayout } from './layout';

/** Burned-in subtitle of the current cue, white on a dark box, with a short pop-in. */
export function Subtitles({ cues }: { cues: SubtitleCue[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const cue = cueAtFrame(cues, frame, fps);
  if (!cue) return null;

  const since = frame - Math.floor(cue.start * fps);
  const scale = interpolate(since, [0, 5], [0.92, 1], clamp);
  const opacity = interpolate(since, [0, 3], [0, 1], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: layout.sideMargin,
        right: layout.sideMargin,
        top: layout.subtitleCenter,
        transform: `translateY(-50%) scale(${scale})`,
        opacity,
        textAlign: 'center',
      }}
    >
      <span
        style={{
          fontSize: layout.fontSize.subtitles,
          fontWeight: 800,
          lineHeight: 1.45,
          color: COLORS.text,
          backgroundColor: 'rgba(10, 11, 14, 0.78)',
          padding: '0.1em 0.42em',
          borderRadius: '0.22em',
          boxDecorationBreak: 'clone',
          WebkitBoxDecorationBreak: 'clone',
        }}
      >
        {cue.text}
      </span>
    </div>
  );
}
