import type { CSSProperties } from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Spec } from '../../lib/render/specs';
import { displayText } from '../../lib/render/timeline';
import { COLORS, clamp, fitFontSize, fitTitleSize, useLayout } from './layout';

/** Fade and rise of a block entering `delay` frames after its parent. */
function useEnter(): (delay: number) => CSSProperties {
  const frame = useCurrentFrame();
  const ease = { ...clamp, easing: Easing.out(Easing.cubic) };
  return (delay) => ({
    opacity: interpolate(frame, [delay, delay + 10], [0, 1], clamp),
    transform: `translateY(${interpolate(frame, [delay, delay + 16], [36, 0], ease)}px)`,
  });
}

/** A key fact in a rounded pill, popping in after `delay` frames. */
export function Chip({ text, delay, fontSize }: { text: string; delay: number; fontSize: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - delay, fps, config: { damping: 13, stiffness: 170 } });
  return (
    <div
      style={{
        padding: '0.28em 0.62em',
        borderRadius: 999,
        backgroundColor: COLORS.chip,
        border: `2px solid ${COLORS.line}`,
        fontSize,
        fontWeight: 700,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        opacity: Math.min(1, pop * 1.4),
        transform: `scale(${0.7 + 0.3 * pop})`,
      }}
    >
      {displayText(text)}
    </div>
  );
}

/** Seller line: name, city and phone of the garage or agency, in the accent color. */
function SellerLine({ contact, fontSize, style }: { contact: string; fontSize: number; style: CSSProperties }) {
  return (
    <div
      style={{
        ...style,
        fontSize: fitFontSize(contact, fontSize, 44),
        fontWeight: 800,
        lineHeight: 1.25,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: COLORS.accent,
      }}
    >
      {displayText(contact)}
    </div>
  );
}

/** 9:16 header standing on the photo for the whole video: the title in large type and the key facts as chips. */
export function Header({ title, specs }: { title: string; specs: Spec[] }) {
  const layout = useLayout();
  const enter = useEnter();
  return (
    <div
      style={{
        position: 'absolute',
        ...layout.header,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div style={{ ...enter(0), width: 88, height: 10, borderRadius: 5, backgroundColor: COLORS.accent, marginBottom: 28 }} />
      <div
        style={{
          ...enter(2),
          fontSize: fitTitleSize(title, layout.fontSize.title, 15, layout.header.width),
          fontWeight: 900,
          lineHeight: 1.02,
          letterSpacing: '-0.03em',
        }}
      >
        {displayText(title)}
      </div>
      {specs.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 26 }}>
          {specs.map((s, i) => (
            <Chip key={s.label} text={s.chip} delay={10 + i * 3} fontSize={layout.fontSize.chip} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 16:9 side panel right of the photo, like a spec sheet: title, seller and price
 * (social variant only), then the key facts, one per row.
 */
export function SidePanel({
  title,
  contact,
  price,
  specs,
}: {
  title: string;
  contact?: string;
  price?: string;
  specs: Spec[];
}) {
  const layout = useLayout();
  const enter = useEnter();
  const { fontSize } = layout;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: layout.photo.width,
          top: 0,
          right: 0,
          bottom: 0,
          backgroundColor: COLORS.panel,
        }}
      />
      <div style={{ position: 'absolute', ...layout.header, display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...enter(0), width: 72, height: 8, borderRadius: 4, backgroundColor: COLORS.accent, marginBottom: 30 }} />
        <div
          style={{
            ...enter(2),
            fontSize: fitTitleSize(title, fontSize.title, 20, layout.header.width),
            fontWeight: 900,
            lineHeight: 1.04,
            letterSpacing: '-0.03em',
          }}
        >
          {displayText(title)}
        </div>
        {contact ? <SellerLine contact={contact} fontSize={fontSize.label} style={{ ...enter(5), marginTop: 18 }} /> : null}
        {price ? (
          <div
            style={{
              ...enter(8),
              alignSelf: 'flex-start',
              marginTop: 26,
              padding: '0.14em 0.45em',
              borderRadius: 14,
              backgroundColor: COLORS.accent,
              color: COLORS.ink,
              fontSize: fontSize.price,
              fontWeight: 900,
              letterSpacing: '-0.02em',
              whiteSpace: 'nowrap',
            }}
          >
            {displayText(price)}
          </div>
        ) : null}
        <div style={{ marginTop: 40 }}>
          {specs.map((s, i) => (
            <div key={s.label} style={{ ...enter(8 + i * 3), padding: '20px 0', borderTop: `2px solid ${COLORS.line}` }}>
              <div
                style={{
                  fontSize: fontSize.label,
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: COLORS.muted,
                }}
              >
                {s.label}
              </div>
              <div style={{ marginTop: 6, fontSize: fontSize.chip + 10, fontWeight: 800, lineHeight: 1.15 }}>
                {displayText(s.value)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
