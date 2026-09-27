import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, clamp, useLayout } from './layout';

/** Price pill in the top-left corner between the title card and the end card (social variant). */
export function PriceBadge({ price, durationInFrames }: { price: string; durationInFrames: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const pop = spring({ frame, fps, config: { damping: 14, stiffness: 160 } });
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: layout.sideMargin,
        top: layout.badgeTop,
        padding: '14px 30px',
        borderRadius: 999,
        backgroundColor: COLORS.accent,
        color: COLORS.ink,
        fontSize: Math.round(layout.fontSize.price * 0.62),
        fontWeight: 800,
        letterSpacing: '-0.01em',
        boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
        transform: `scale(${0.6 + 0.4 * pop})`,
        transformOrigin: 'left center',
        opacity: Math.min(pop * 1.5, 1) * out,
        whiteSpace: 'nowrap',
      }}
    >
      {price}
    </div>
  );
}
