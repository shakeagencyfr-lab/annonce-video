import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { COLORS, clamp, fitFontSize, useLayout } from './layout';

/**
 * Closing card over the last photo. The social variant adds the price and the
 * contact; the listing variant never gets them (the caller passes neither).
 */
export function EndCard({
  title,
  subtitle,
  price,
  contact,
}: {
  title: string;
  subtitle?: string;
  price?: string;
  contact?: string;
}) {
  const frame = useCurrentFrame();
  const layout = useLayout();
  const ease = { ...clamp, easing: Easing.out(Easing.cubic) };
  const veil = interpolate(frame, [0, 12], [0, 1], clamp);
  const enter = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 12], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 16], [30, 0], ease)}px)`,
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: 'rgba(10, 11, 14, 0.88)', opacity: veil }} />
      <div
        style={{
          position: 'absolute',
          left: layout.sideMargin,
          right: layout.sideMargin,
          top: layout.endCardCenter,
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 26,
        }}
      >
        <div style={{ ...enter(0), width: 110, height: 10, borderRadius: 5, backgroundColor: COLORS.accent }} />
        <div
          style={{
            ...enter(2),
            fontSize: fitFontSize(title, layout.fontSize.title, layout.vertical ? 36 : 48),
            fontWeight: 800,
            lineHeight: 1.06,
            letterSpacing: '-0.02em',
            maxWidth: layout.vertical ? undefined : layout.width * 0.7,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              ...enter(6),
              fontSize: fitFontSize(subtitle, layout.fontSize.subtitle, 44),
              fontWeight: 400,
              lineHeight: 1.25,
              color: COLORS.muted,
            }}
          >
            {subtitle}
          </div>
        ) : null}
        {price ? (
          <div
            style={{
              ...enter(10),
              marginTop: 12,
              padding: '14px 40px',
              borderRadius: 999,
              backgroundColor: COLORS.accent,
              color: COLORS.ink,
              fontSize: layout.fontSize.price,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              whiteSpace: 'nowrap',
            }}
          >
            {price}
          </div>
        ) : null}
        {contact ? (
          <div
            style={{
              ...enter(14),
              fontSize: fitFontSize(contact, layout.fontSize.contact, 36),
              fontWeight: 700,
              lineHeight: 1.25,
            }}
          >
            {contact}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}
