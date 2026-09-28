import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { displayText } from '../../lib/render/timeline';
import { COLORS, clamp, fitFontSize, useLayout } from './layout';

/** Frames after the start of the video before the price pops in, once the title is read. */
export const PRICE_DELAY_FRAMES = 18;

/** "Garage · Ville · 06 …" from the script: the name, then the rest. */
export function splitContact(contact: string | undefined): { name?: string; details?: string } {
  const [name, ...rest] = (contact ?? '').split(' · ').map((part) => part.trim()).filter(Boolean);
  return { ...(name ? { name } : {}), ...(rest.length > 0 ? { details: rest.join(' · ') } : {}) };
}

/**
 * 9:16 footer under the photo (social variant): the price in large type and the seller
 * next to it, from just after the opening until the end card, which repeats them.
 */
export function Footer({ price, contact, durationInFrames }: { price?: string; contact?: string; durationInFrames: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const pop = spring({ frame: frame - PRICE_DELAY_FRAMES, fps, config: { damping: 12, stiffness: 150 } });
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], clamp);
  const sellerIn = PRICE_DELAY_FRAMES + (price ? 8 : 0);
  const ease = { ...clamp, easing: Easing.out(Easing.cubic) };
  const { name, details } = splitContact(contact);
  return (
    <div
      style={{
        position: 'absolute',
        ...layout.footer,
        display: 'flex',
        alignItems: 'center',
        gap: 34,
        opacity: out,
      }}
    >
      {price ? (
        <div
          style={{
            flexShrink: 0,
            padding: '0.06em 0.36em',
            borderRadius: 20,
            backgroundColor: COLORS.accent,
            color: COLORS.ink,
            fontSize: layout.fontSize.price,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            boxShadow: '0 14px 40px rgba(0,0,0,0.45)',
            transform: `scale(${0.5 + 0.5 * pop}) rotate(${-4 * (1 - pop)}deg)`,
            transformOrigin: 'left center',
            opacity: Math.min(1, pop * 1.5),
            whiteSpace: 'nowrap',
          }}
        >
          {displayText(price)}
        </div>
      ) : null}
      {name ? (
        <div
          style={{
            minWidth: 0,
            opacity: interpolate(frame, [sellerIn, sellerIn + 10], [0, 1], clamp),
            transform: `translateX(${interpolate(frame, [sellerIn, sellerIn + 16], [-30, 0], ease)}px)`,
          }}
        >
          <div
            style={{
              fontSize: fitFontSize(name, layout.fontSize.label + 4, 18),
              fontWeight: 800,
              lineHeight: 1.15,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {displayText(name)}
          </div>
          {details ? (
            <div
              style={{
                marginTop: 6,
                fontSize: fitFontSize(details, layout.fontSize.label, 24),
                lineHeight: 1.25,
                color: COLORS.muted,
              }}
            >
              {displayText(details)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
