import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureAudioFile } from '@/lib/render/local';

/** Mono 16-bit WAV of a 997 Hz tone, at 44.1 kHz like the ElevenLabs voice-overs. */
function toneWav(amplitude: number, sec: number, rate = 44_100): Buffer {
  const count = Math.round(sec * rate);
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write('WAVEfmt ', 8, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    wav.writeInt16LE(Math.round(32767 * amplitude * Math.sin((2 * Math.PI * 997 * i) / rate)), 44 + 2 * i);
  }
  return wav;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'measure-audio-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Runs the ffmpeg bundled with @remotion/renderer, as the render does.
describe('measureAudioFile', () => {
  it('measures a mono file as the render mixes it: same loudness, peak 3 dB lower in stereo', async () => {
    const path = join(dir, 'tone.wav');
    await writeFile(path, toneWav(0.25, 3));
    const level = await measureAudioFile(path);
    // A -12 dBFS tone in one channel is -15.05 LUFS; spread to two channels at -3 dB, the same.
    expect(level.loudnessLufs).toBeCloseTo(-15.05, 1);
    expect(level.peakDbfs).toBeCloseTo(-15.05, 1);
  });

  it('fails with the name of the file when ffmpeg cannot read it', async () => {
    const path = join(dir, 'voix.mp3');
    await writeFile(path, 'not audio');
    await expect(measureAudioFile(path)).rejects.toThrow('Lecture de la voix impossible (voix.mp3)');
  });
});
