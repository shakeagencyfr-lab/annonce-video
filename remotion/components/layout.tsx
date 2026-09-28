import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, useVideoConfig } from 'remotion';
import type { Box } from '../../lib/render/timeline';

/** Shared look of the listing videos: font, colors, where each block sits per orientation. */

export const FONT_FAMILY = 'Inter, "Helvetica Neue", Arial, sans-serif';

export const COLORS = {
  text: '#FFFFFF',
  muted: 'rgba(255, 255, 255, 0.66)',
  line: 'rgba(255, 255, 255, 0.14)',
  chip: 'rgba(255, 255, 255, 0.10)',
  ink: '#0B0C10',
  accent: '#FFD23F',
  background: '#0B0C10',
  panel: '#111319',
} as const;

/** Shade over the blurred photo behind the 9:16 layout: darker at the top and bottom. */
export const BACKDROP_SHADE =
  'linear-gradient(to bottom, rgba(11,12,16,0.72) 0%, rgba(11,12,16,0.45) 30%, rgba(11,12,16,0.45) 72%, rgba(11,12,16,0.8) 100%)';

export type Layout = {
  vertical: boolean;
  width: number;
  height: number;
  sideMargin: number;
  /** Frame of the photos: full width in 9:16 (4:3, the shape of listing photos), left 4:3 in 16:9. */
  photo: Box;
  /**
   * 9:16: header standing on the photo (its content is bottom-aligned, a long title grows
   * upward). 16:9: side panel right of the photo.
   */
  header: Box;
  /** Subtitles, over the bottom of the photo. */
  captions: { left: number; width: number; centerY: number; fontSize: number };
  /** 9:16 footer under the photo: price and seller (social variant). */
  footer: { left: number; top: number; width: number };
  dpe: { top?: number; bottom?: number; left?: number; right?: number; cell: number };
  /** End card block center, and where the subtitles move while it is on screen. */
  endCard: { centerY: number; captionsY: number };
  fontSize: {
    label: number;
    title: number;
    chip: number;
    price: number;
    endTitle: number;
    endPrice: number;
    contact: number;
  };
};

/**
 * 9:16 keeps what matters out of the app bars of TikTok, Reels and Shorts (top ~10 %,
 * bottom ~18 %, buttons on the right from mid-height): header from 10 %, photo across
 * the full width, subtitles on its lower part, price and seller under it, all
 * left-aligned. Listing photos are 4:3 and often 800×600, so a 1080-wide 4:3 frame shows
 * them whole at a mild upscale instead of a blurry full-screen crop. 16:9 shows the
 * photo at 1440×1080 with the facts in a panel on the right, as a spec sheet.
 */
export function useLayout(): Layout {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  if (vertical) {
    const sideMargin = Math.round(width * 0.05);
    const photoHeight = Math.round((width * 3) / 4);
    const photoTop = Math.round(height * 0.3);
    const photoBottom = photoTop + photoHeight;
    const headerTop = Math.round(height * 0.1);
    return {
      vertical,
      width,
      height,
      sideMargin,
      photo: { left: 0, top: photoTop, width, height: photoHeight },
      header: { left: sideMargin, top: headerTop, width: width - 2 * sideMargin, height: photoTop - 36 - headerTop },
      captions: { left: sideMargin, width: width - 2 * sideMargin, centerY: photoBottom - 120, fontSize: 64 },
      footer: { left: sideMargin, top: photoBottom + 44, width: Math.round(width * 0.84) },
      dpe: { top: photoTop + 28, right: 28, cell: 38 },
      endCard: { centerY: Math.round(height * 0.41), captionsY: Math.round(height * 0.73) },
      fontSize: { label: 32, title: 116, chip: 32, price: 92, endTitle: 128, endPrice: 140, contact: 52 },
    };
  }
  const photoWidth = Math.round((height * 4) / 3);
  const panelPadding = 56;
  return {
    vertical,
    width,
    height,
    sideMargin: Math.round(width * 0.03),
    photo: { left: 0, top: 0, width: photoWidth, height },
    header: {
      left: photoWidth + panelPadding,
      top: 72,
      width: width - photoWidth - 2 * panelPadding,
      height: height - 2 * 72,
    },
    captions: { left: 60, width: photoWidth - 120, centerY: Math.round(height * 0.895), fontSize: 54 },
    footer: { left: 0, top: 0, width: 0 },
    dpe: { bottom: 64, left: photoWidth + panelPadding, cell: 32 },
    endCard: { centerY: Math.round(height * 0.42), captionsY: Math.round(height * 0.85) },
    fontSize: { label: 24, title: 72, chip: 34, price: 56, endTitle: 116, endPrice: 104, contact: 46 },
  };
}

/** Weights imported in Root.tsx (@fontsource/inter). */
const FONT_WEIGHTS = ['400', '700', '800', '900'] as const;

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

/** Width of a character of Inter Black, in em: generous, so a word never overflows. */
const CHAR_EM = 0.66;

/**
 * fitFontSize(), then small enough for the longest word to fit `width` on its own line:
 * a title only wraps between words.
 */
export function fitTitleSize(text: string, base: number, comfortableChars: number, width: number): number {
  const longest = Math.max(1, ...text.split(/\s+/).map((word) => word.length));
  return Math.min(fitFontSize(text, base, comfortableChars), Math.floor(width / (longest * CHAR_EM)));
}

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
