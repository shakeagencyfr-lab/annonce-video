import { describe, expect, it } from 'vitest';
import {
  LOUDNESS_SAMPLE_RATE,
  VOICE_MAX_GAIN_DB,
  VOICE_PEAK_CEILING_DBFS,
  VOICE_TARGET_LUFS,
  dbToGain,
  gainToDb,
  measureLevel,
  voiceGainDb,
} from '@/lib/render/loudness';

const RATE = LOUDNESS_SAMPLE_RATE;

/** Interleaved sine, the same in every channel, then `silenceSec` of silence. */
function sine(opts: { amplitude: number; hz?: number; sec: number; channels?: number; silenceSec?: number }): Float32Array {
  const { amplitude, hz = 997, sec, channels = 2, silenceSec = 0 } = opts;
  const frames = Math.round(sec * RATE);
  const out = new Float32Array((frames + Math.round(silenceSec * RATE)) * channels);
  for (let f = 0; f < frames; f++) {
    const x = amplitude * Math.sin((2 * Math.PI * hz * f) / RATE);
    for (let c = 0; c < channels; c++) out[f * channels + c] = x;
  }
  return out;
}

describe('measureLevel', () => {
  it('measures a 997 Hz tone as BS.1770 does: 0 dBFS in one channel is -3.01 LUFS', () => {
    expect(measureLevel(sine({ amplitude: 1, sec: 3, channels: 1 }), 1).loudnessLufs).toBeCloseTo(-3.01, 1);
    // Both channels add up: -20 dBFS in each gives -20 LUFS.
    expect(measureLevel(sine({ amplitude: 0.1, sec: 3 }), 2).loudnessLufs).toBeCloseTo(-20, 1);
  });

  it('gives a mono voice spread to both channels at -3 dB the loudness of the mono file', () => {
    const mono = measureLevel(sine({ amplitude: 0.2, sec: 3, channels: 1 }), 1);
    const upmix = measureLevel(sine({ amplitude: 0.2 * Math.SQRT1_2, sec: 3 }), 2);
    expect(upmix.loudnessLufs).toBeCloseTo(mono.loudnessLufs, 1);
    expect(upmix.peakDbfs).toBeCloseTo(mono.peakDbfs - 3.01, 1);
  });

  it('weights low frequencies down (K-weighting)', () => {
    const low = measureLevel(sine({ amplitude: 0.1, hz: 40, sec: 3 }), 2).loudnessLufs;
    expect(low).toBeLessThan(-21);
  });

  it('leaves pauses out of the integrated loudness (gates)', () => {
    const speech = measureLevel(sine({ amplitude: 0.1, sec: 4 }), 2).loudnessLufs;
    const withPauses = measureLevel(sine({ amplitude: 0.1, sec: 4, silenceSec: 4 }), 2).loudnessLufs;
    expect(withPauses).toBeCloseTo(speech, 0);
    expect(Math.abs(withPauses - speech)).toBeLessThan(0.3);
  });

  it('reports the sample peak in dBFS', () => {
    expect(measureLevel(sine({ amplitude: 0.5, sec: 1 }), 2).peakDbfs).toBeCloseTo(-6.02, 2);
  });

  it('has no loudness for silence or less than one 400 ms block', () => {
    const silence = measureLevel(new Float32Array(RATE * 2), 2);
    expect(silence.loudnessLufs).toBe(-Infinity);
    expect(silence.peakDbfs).toBe(-Infinity);
    expect(measureLevel(sine({ amplitude: 0.5, sec: 0.3 }), 2).loudnessLufs).toBe(-Infinity);
    expect(() => measureLevel(new Float32Array(4), 0)).toThrow('Nombre de canaux invalide');
  });
});

describe('voiceGainDb', () => {
  it('brings a quiet voice with headroom to the target', () => {
    // The 9:16 voice of the audit: -19.2 LUFS, -4.8 dBFS once in stereo.
    const gain = voiceGainDb({ loudnessLufs: -19.2, peakDbfs: -4.8 });
    expect(gain).toBeCloseTo(3.2, 6);
    expect(-19.2 + gain).toBeCloseTo(VOICE_TARGET_LUFS, 6);
  });

  it('stops at the peak ceiling instead of clipping', () => {
    const level = { loudnessLufs: -21.7, peakDbfs: -4.9 };
    const gain = voiceGainDb(level);
    expect(level.peakDbfs + gain).toBeCloseTo(VOICE_PEAK_CEILING_DBFS, 6);
    expect(level.loudnessLufs + gain).toBeLessThan(VOICE_TARGET_LUFS);
  });

  it('turns a loud voice down, and a voice over the ceiling down to it', () => {
    expect(voiceGainDb({ loudnessLufs: -12, peakDbfs: -3 })).toBeCloseTo(-4, 6);
    expect(voiceGainDb({ loudnessLufs: -18, peakDbfs: 0.5 })).toBeCloseTo(VOICE_PEAK_CEILING_DBFS - 0.5, 6);
  });

  it('never boosts more than VOICE_MAX_GAIN_DB, and leaves silence alone', () => {
    expect(voiceGainDb({ loudnessLufs: -45, peakDbfs: -30 })).toBe(VOICE_MAX_GAIN_DB);
    expect(voiceGainDb({ loudnessLufs: -Infinity, peakDbfs: -Infinity })).toBe(0);
  });

  it('converts between dB and linear gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6.0206)).toBeCloseTo(2, 4);
    expect(gainToDb(dbToGain(3.2))).toBeCloseTo(3.2, 9);
  });
});
