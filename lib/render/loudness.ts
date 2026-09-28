/**
 * Level of the voice-over: integrated loudness after ITU-R BS.1770-4 (K-weighting,
 * 400 ms blocks every 100 ms, absolute gate at -70 LUFS, relative gate at -10 LU) and
 * sample peak, then the constant gain that brings the voice to the target without
 * clipping. ElevenLabs output varies from one call to the next (-19 to -22 LUFS
 * measured), below the -14 to -16 LUFS of the feeds. Pure: lib/render/local.ts decodes
 * the file.
 */

/** Sample rate the K-weighting coefficients below are given for. */
export const LOUDNESS_SAMPLE_RATE = 48_000;
/** Loudness aimed at, close to what social networks and YouTube play. */
export const VOICE_TARGET_LUFS = -16;
/** Highest sample peak after the gain, leaving room for inter-sample peaks and AAC. */
export const VOICE_PEAK_CEILING_DBFS = -1;
/** Largest boost, so that a nearly silent file is not turned into noise. */
export const VOICE_MAX_GAIN_DB = 12;

export type AudioLevel = { loudnessLufs: number; peakDbfs: number };

/** K-weighting at 48 kHz: high shelf, then high pass (BS.1770-4, tables 1 and 2). */
const SHELF = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const HIGH_PASS = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

const SEGMENT = LOUDNESS_SAMPLE_RATE / 10;
const SEGMENTS_PER_BLOCK = 4;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

/** Loudness of a mean square summed over the channels (all weighted 1: front channels). */
const loudnessOf = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

export const gainToDb = (gain: number) => 20 * Math.log10(gain);
export const dbToGain = (db: number) => 10 ** (db / 20);

/**
 * Integrated loudness and sample peak of interleaved samples in [-1, 1] at 48 kHz.
 * Silence, or audio shorter than one 400 ms block, has a loudness of -Infinity.
 */
export function measureLevel(samples: ArrayLike<number>, channels: number): AudioLevel {
  if (!Number.isInteger(channels) || channels < 1) throw new Error(`Nombre de canaux invalide : ${channels}`);
  const frames = Math.floor(samples.length / channels);
  const segments = Math.floor(frames / SEGMENT);
  // Sum over the channels of the K-weighted squares, per 100 ms segment.
  const energy = new Float64Array(segments);
  let peak = 0;
  for (let c = 0; c < channels; c++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let f = 0; f < frames; f++) {
      const x = samples[f * channels + c] ?? 0;
      peak = Math.max(peak, Math.abs(x));
      const y = SHELF.b0 * x + SHELF.b1 * x1 + SHELF.b2 * x2 - SHELF.a1 * y1 - SHELF.a2 * y2;
      const z = HIGH_PASS.b0 * y + HIGH_PASS.b1 * y1 + HIGH_PASS.b2 * y2 - HIGH_PASS.a1 * z1 - HIGH_PASS.a2 * z2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      z2 = z1;
      z1 = z;
      const s = Math.floor(f / SEGMENT);
      if (s < segments) energy[s] = (energy[s] ?? 0) + z * z;
    }
  }

  const blocks: number[] = [];
  for (let s = 0; s + SEGMENTS_PER_BLOCK <= segments; s++) {
    let sum = 0;
    for (let k = s; k < s + SEGMENTS_PER_BLOCK; k++) sum += energy[k] ?? 0;
    blocks.push(sum / (SEGMENTS_PER_BLOCK * SEGMENT));
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const loud = blocks.filter((ms) => loudnessOf(ms) > ABSOLUTE_GATE_LUFS);
  const peakDbfs = gainToDb(peak);
  if (loud.length === 0) return { loudnessLufs: -Infinity, peakDbfs };
  const relativeGate = loudnessOf(mean(loud)) + RELATIVE_GATE_LU;
  const gated = loud.filter((ms) => loudnessOf(ms) > relativeGate);
  return { loudnessLufs: loudnessOf(mean(gated)), peakDbfs };
}

/**
 * Gain in dB that brings a voice to VOICE_TARGET_LUFS, lowered when its peak would go
 * over VOICE_PEAK_CEILING_DBFS (the render applies a plain gain, no limiter) and capped
 * at VOICE_MAX_GAIN_DB. Negative for a voice louder than the target; 0 for silence.
 */
export function voiceGainDb(level: AudioLevel): number {
  if (!Number.isFinite(level.loudnessLufs)) return 0;
  const toTarget = VOICE_TARGET_LUFS - level.loudnessLufs;
  const headroom = Number.isFinite(level.peakDbfs) ? VOICE_PEAK_CEILING_DBFS - level.peakDbfs : Infinity;
  return Math.min(toTarget, headroom, VOICE_MAX_GAIN_DB);
}
