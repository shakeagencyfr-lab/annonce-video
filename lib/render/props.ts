import type { Format, PhotoRole, SubtitleCue, Variant } from '../pipeline/types';

/**
 * Input props of the Remotion compositions (remotion/). Every media path is a file
 * name inside the render's public directory, loaded with staticFile(). Serializable:
 * passed as inputProps to renderMedia().
 */
export type VideoProps = {
  format: Format;
  variant: Variant;
  vertical: 'auto' | 'immo';
  fps: number;
  durationInFrames: number;
  photos: { src: string; role: PhotoRole; width: number; height: number }[];
  /** Voice-over file; absent in silent test renders. */
  voiceSrc?: string;
  /**
   * Linear gain of the voice-over (1: as recorded; above 1 amplifies). Set by the render
   * from the measured loudness of the file (lib/render/loudness.ts) when absent.
   */
  voiceVolume?: number;
  /** Background music, only from a royalty-free library with a commercial license (rule 6). */
  musicSrc?: string;
  subtitles: SubtitleCue[];
  overlays: { title: string; subtitle?: string; price?: string; contact?: string };
  /** DPE class read from the listing, immo only (rule 5). */
  dpe?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /** Watermark on previews only. */
  watermark: boolean;
};

export const FPS = 30;

export const DIMENSIONS: Record<Format, { width: number; height: number }> = {
  '9x16': { width: 1080, height: 1920 },
  '16x9': { width: 1920, height: 1080 },
};

export const COMPOSITION_ID: Record<Format, string> = {
  '9x16': 'ListingVertical',
  '16x9': 'ListingHorizontal',
};
