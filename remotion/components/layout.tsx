import { Fragment, useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, useVideoConfig } from 'remotion';
import { textWidthEm } from '../../lib/pipeline/subtitles';
import { containedBox } from '../../lib/render/timeline';

/** Shared look of the listing videos: font, colors, safe areas per orientation. */

export const FONT_FAMILY = 'Inter, "Helvetica Neue", Arial, sans-serif';

export const COLORS = {
  text: '#FFFFFF',
  muted: 'rgba(255, 255, 255, 0.82)',
  ink: '#101114',
  accent: '#FFD23F',
  panel: 'rgba(12, 13, 16, 0.62)',
  background: '#0E0F12',
} as const;

export type Layout = {
  vertical: boolean;
  width: number;
  height: number;
  /** Side margin kept free of text. */
  sideMargin: number;
  /**
   * Right edge of the subtitles and of the end card block, from the right. In 9:16 it
   * keeps text clear of the action column of TikTok, Reels and Shorts (like, comment,
   * share, from mid-height down); in 16:9 it is the side margin. The title card, above
   * that column, keeps the side margin.
   */
  textRight: number;
  /** Top of the corner badges, below the app bars of TikTok, Reels and Shorts in 9:16. */
  badgeTop: number;
  /**
   * Title block position. 9:16 gives it a band between the corner badges and the top of
   * a 4:3 photo, and stands it on the bottom of the band so that it stays clear of the
   * photo; a block taller than the band hangs from its top instead and grows toward the
   * photo, not under the DPE badge. 16:9 stands it on its bottom edge, left of the badges.
   */
  title: { top: number; bottom: number } | { bottom: number };
  /** Vertical center of the subtitle line, from the top. */
  subtitleCenter: number;
  /** Vertical center of the end card block, from the top. */
  endCardCenter: number;
  fontSize: { title: number; subtitle: number; subtitles: number; price: number; contact: number };
};

/**
 * 9:16 keeps text between the app bars (top ~10 %, bottom ~20 %) and left of the
 * action column (right ~13 %, from mid-height down). A landscape photo spans the
 * width around the middle (y 555 to 1365 for 4:3, Photos.tsx); the title card stands
 * just above it, the subtitles sit just below it, above the bottom bar, and the end
 * card block above them. 16:9 puts the subtitles near the bottom, as on YouTube.
 */
export function useLayout(): Layout {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  if (vertical) {
    const badgeTop = Math.round(height * 0.1);
    const photoTop = containedBox({ width: 4, height: 3 }, { width, height }).top;
    return {
      vertical,
      width,
      height,
      sideMargin: Math.round(width * 0.06),
      textRight: Math.round(width * 0.13),
      badgeTop,
      // The title text starts below the badge row (DPE and price badges are under 100 px
      // high); above it, the accent bar and its margin take 38 px on the left, where the
      // price badge only appears after the title card. The block ends 20 px above a 4:3
      // photo.
      title: { top: badgeTop + 100 - 38, bottom: height - Math.round(photoTop - 20) },
      subtitleCenter: Math.round(height * 0.745),
      endCardCenter: Math.round(height * 0.42),
      fontSize: { title: 78, subtitle: 42, subtitles: 56, price: 88, contact: 44 },
    };
  }
  const sideMargin = Math.round(width * 0.05);
  return {
    vertical,
    width,
    height,
    sideMargin,
    textRight: sideMargin,
    badgeTop: Math.round(height * 0.06),
    title: { bottom: height - Math.round(height * 0.7) },
    subtitleCenter: Math.round(height * 0.88),
    endCardCenter: Math.round(height * 0.43),
    fontSize: { title: 84, subtitle: 44, subtitles: 54, price: 84, contact: 44 },
  };
}

/** Weights imported in Root.tsx (@fontsource/inter). */
const FONT_WEIGHTS = ['400', '700', '800'] as const;

/**
 * Holds the render until Inter is loaded, so no frame is drawn with a fallback font.
 * document.fonts.load() resolves with no face when the font is not declared (CSS
 * import lost by the bundler): the render fails then instead of using Arial.
 */
export function useFontsReady(): void {
  const [handle] = useState(() => delayRender('Chargement de la police Inter'));
  useEffect(() => {
    const sample = 'Aé€’ 0';
    Promise.all(FONT_WEIGHTS.map((weight) => document.fonts.load(`${weight} 40px Inter`, sample)))
      .then(async (faces) => {
        const missing = FONT_WEIGHTS.filter((_, i) => (faces[i]?.length ?? 0) === 0);
        if (missing.length > 0) throw new Error(`Police Inter introuvable (graisses ${missing.join(', ')})`);
        await document.fonts.ready;
      })
      .then(
        () => continueRender(handle),
        (err: unknown) => cancelRender(err),
      );
  }, [handle]);
}

/**
 * Font size for a text that should fit in about `comfortableChars` at `base` size:
 * longer texts shrink (area grows with the square of the size), down to 60 %.
 */
export function fitFontSize(text: string, base: number, comfortableChars: number): number {
  if (text.length <= comfortableChars) return base;
  return Math.round(base * Math.max(0.6, Math.sqrt(comfortableChars / text.length)));
}

/**
 * Font size at which a one-line text, with `paddingEm` on each side, fits in
 * `boxWidth`: `base`, or less when its estimated width (textWidthEm) is larger.
 */
export function fitLineFontSize(text: string, base: number, boxWidth: number, paddingEm: number): number {
  const widthEm = textWidthEm(text) + 2 * paddingEm;
  return Math.min(base, Math.floor(boxWidth / widthEm));
}

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/**
 * A line of parts joined by « · » (« GARAGE MARTIN · Saint-Ouen-sur-Seine »,
 * « 2019 · 68 000 km · Essence ») that wraps between the parts rather than inside one,
 * e.g. at a hyphen of a town name; the « · » stays at the end of the first line.
 */
export function SeparatedText({ text }: { text: string }) {
  const parts = text.split(' · ');
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? ' ' : null}
          <span style={{ display: 'inline-block' }}>{i < parts.length - 1 ? `${part}\u00A0·` : part}</span>
        </Fragment>
      ))}
    </>
  );
}
