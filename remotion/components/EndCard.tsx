import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoProps } from '../../lib/render/props';
import type { Spec } from '../../lib/render/specs';
import { displayText } from '../../lib/render/timeline';
import { splitContact } from './Footer';
import { DpeBadge } from './DpeBadge';
import { Chip } from './Header';
import { COLORS, clamp, fitFontSize, fitTitleSize, useLayout } from './layout';
import { BlurredPhoto } from './Photos';

/**
 * Closing card over the whole frame, on the first photo blurred: title, key facts and
 * DPE class (immo, rule 5), plus the price in large type and the seller's contact in the
 * social variant. The listing variant never gets them (the caller passes neither).
 */
export function EndCard({
  title,
  specs,
  price,
  contact,
  dpe,
  backdropSrc,
}: {
  title: string;
  specs: Spec[];
  price?: string;
  contact?: string;
  dpe?: NonNullable<VideoProps['dpe']>;
  backdropSrc?: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useLayout();
  const ease = { ...clamp, easing: Easing.out(Easing.cubic) };
  const veil = interpolate(frame, [0, 10], [0, 1], clamp);
  const enter = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 10], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 16], [40, 0], ease)}px)`,
  });
  const pricePop = spring({ frame: frame - 10, fps, config: { damping: 11, stiffness: 140 } });
  const { name, details } = splitContact(contact);

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: COLORS.background, opacity: veil }}>
        {backdropSrc ? <BlurredPhoto src={backdropSrc} /> : null}
        <AbsoluteFill style={{ backgroundColor: 'rgba(11, 12, 16, 0.55)' }} />
      </AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: layout.sideMargin,
          right: layout.sideMargin,
          top: layout.endCard.centerY,
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div style={{ ...enter(0), width: 96, height: 10, borderRadius: 5, backgroundColor: COLORS.accent }} />
        <div
          style={{
            ...enter(2),
            marginTop: 34,
            fontSize: fitTitleSize(
              title,
              layout.fontSize.endTitle,
              layout.vertical ? 15 : 26,
              layout.width - 2 * layout.sideMargin,
            ),
            fontWeight: 900,
            lineHeight: 1.02,
            letterSpacing: '-0.03em',
          }}
        >
          {displayText(title)}
        </div>
        {specs.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 30 }}>
            {specs.map((s, i) => (
              <Chip key={s.label} text={s.chip} delay={5 + i * 2} fontSize={Math.round(layout.fontSize.chip * 1.15)} />
            ))}
          </div>
        ) : null}
        {dpe ? (
          <div style={{ ...enter(8), marginTop: 30 }}>
            <DpeBadge dpe={dpe} inline />
          </div>
        ) : null}
        {price ? (
          <div
            style={{
              marginTop: 48,
              padding: '0.08em 0.4em',
              borderRadius: 24,
              backgroundColor: COLORS.accent,
              color: COLORS.ink,
              fontSize: layout.fontSize.endPrice,
              fontWeight: 900,
              letterSpacing: '-0.03em',
              whiteSpace: 'nowrap',
              boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
              opacity: Math.min(1, pricePop * 1.5),
              transform: `scale(${0.6 + 0.4 * pricePop})`,
            }}
          >
            {displayText(price)}
          </div>
        ) : null}
        {name ? (
          <div
            style={{
              ...enter(16),
              marginTop: 44,
              fontSize: fitFontSize(name, layout.fontSize.contact, 24),
              fontWeight: 800,
              lineHeight: 1.2,
            }}
          >
            {displayText(name)}
          </div>
        ) : null}
        {details ? (
          <div
            style={{
              ...enter(19),
              marginTop: 10,
              fontSize: Math.round(layout.fontSize.contact * 0.78),
              fontWeight: 400,
              lineHeight: 1.3,
              color: COLORS.muted,
            }}
          >
            {displayText(details)}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}
