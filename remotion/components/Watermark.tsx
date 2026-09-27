import { AbsoluteFill } from 'remotion';
import { useLayout } from './layout';

const WORD = 'APERÇU';
const FONT_SIZE = 96;
const ROW_GAP = 240;

/**
 * Preview watermark: "APERÇU" repeated in diagonal rows over the whole frame, light
 * with a dark halo so it shows on bright and dark photos alike.
 */
export function Watermark() {
  const { width, height } = useLayout();
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rows = Math.ceil(diagonal / ROW_GAP) + 1;
  const line = Array.from({ length: Math.ceil(diagonal / (FONT_SIZE * 3.2)) + 2 }, () => WORD).join('  ');
  return (
    <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: (width - diagonal) / 2,
          top: (height - diagonal) / 2,
          width: diagonal,
          height: diagonal,
          transform: 'rotate(-30deg)',
          // Own compositing layer: the rotated text is drawn once, not on every frame.
          willChange: 'transform',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            style={{
              whiteSpace: 'nowrap',
              marginLeft: i % 2 === 0 ? -FONT_SIZE * 2 : -FONT_SIZE * 4.5,
              fontSize: FONT_SIZE,
              fontWeight: 800,
              letterSpacing: '0.08em',
              color: 'rgba(255, 255, 255, 0.22)',
              textShadow: '0 0 3px rgba(0, 0, 0, 0.22)',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}
