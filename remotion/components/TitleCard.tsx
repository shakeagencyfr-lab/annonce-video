import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { COLORS, SeparatedText, clamp, fitFontSize, useLayout } from './layout';

/** Opening card: title and subtitle over a dark scrim, visible from the first frame. */
export function TitleCard({
  title,
  subtitle,
  durationInFrames,
}: {
  title: string;
  subtitle?: string;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const layout = useLayout();
  const ease = { ...clamp, easing: Easing.out(Easing.cubic) };
  const rise = interpolate(frame, [0, 16], [28, 0], ease);
  const bar = interpolate(frame, [0, 14], [0, 1], ease);
  const subtitleIn = interpolate(frame, [4, 18], [0, 1], ease);
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp);

  const scrim = layout.vertical
    ? 'linear-gradient(to bottom, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.5) 22%, rgba(0,0,0,0) 42%)'
    : 'linear-gradient(to right, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.4) 40%, rgba(0,0,0,0) 68%)';

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <AbsoluteFill style={{ background: scrim }} />
      <div
        style={{
          position: 'absolute',
          left: layout.sideMargin,
          // 9:16: the title sits above the action column of the networks, so it keeps the
          // side margin (layout.textRight is for the subtitles and the end card).
          right: layout.vertical ? layout.sideMargin : layout.width * 0.4,
          ...layout.title,
          display: 'flex',
          flexDirection: 'column',
          transform: `translateY(${rise}px)`,
        }}
      >
        {/* Takes the free height of the band (9:16), so the block stands on its bottom. */}
        <div style={{ flexGrow: 1 }} />
        <div style={{ flexShrink: 0 }}>
          <div
            style={{
              width: 110 * bar,
              height: 10,
              borderRadius: 5,
              backgroundColor: COLORS.accent,
              marginBottom: 28,
            }}
          />
          <div
            style={{
              fontSize: fitFontSize(title, layout.fontSize.title, layout.vertical ? 36 : 40),
              fontWeight: 800,
              lineHeight: 1.06,
              letterSpacing: '-0.02em',
              textShadow: '0 4px 24px rgba(0,0,0,0.45)',
            }}
          >
            {title}
          </div>
          {subtitle ? (
            <div
              style={{
                marginTop: 18,
                fontSize: fitFontSize(subtitle, layout.fontSize.subtitle, 44),
                fontWeight: 400,
                lineHeight: 1.25,
                color: COLORS.muted,
                opacity: subtitleIn,
                textShadow: '0 2px 16px rgba(0,0,0,0.5)',
              }}
            >
              <SeparatedText text={subtitle} />
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
}
