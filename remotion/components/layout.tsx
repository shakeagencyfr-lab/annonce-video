import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, useVideoConfig } from 'remotion';

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
  /** Top of the corner badges, below the app bars of TikTok, Reels and Shorts in 9:16. */
  badgeTop: number;
  /**
   * Title block anchor. 9:16 hangs it from its top, below the corner badges, so a long
   * title grows toward the photo instead of under the DPE badge; 16:9 stands it on its
   * bottom edge, left of the badges.
   */
  title: { top: number } | { bottom: number };
  /** Vertical center of the subtitle line, from the top. */
  subtitleCenter: number;
  /** Vertical center of the end card block, from the top. */
  endCardCenter: number;
  fontSize: { title: number; subtitle: number; subtitles: number; price: number; contact: number };
};

/**
 * 9:16 keeps text between the app bars (top ~10 %, bottom ~20 %): subtitles around
 * 72 % of the height, where networks do not overlay their buttons. 16:9 puts the
 * subtitles near the bottom, as on YouTube.
 */
export function useLayout(): Layout {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  if (vertical) {
    const badgeTop = Math.round(height * 0.1);
    return {
      vertical,
      width,
      height,
      sideMargin: Math.round(width * 0.06),
      badgeTop,
      // Below the badge row (DPE and price badges are under 100 px high).
      title: { top: badgeTop + Math.round(height * 0.065) },
      subtitleCenter: Math.round(height * 0.72),
      endCardCenter: Math.round(height * 0.42),
      fontSize: { title: 78, subtitle: 42, subtitles: 56, price: 88, contact: 44 },
    };
  }
  return {
    vertical,
    width,
    height,
    sideMargin: Math.round(width * 0.05),
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

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
