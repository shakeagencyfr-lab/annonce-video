import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoProps } from '@/lib/render/props';

const remotion = vi.hoisted(() => ({
  bundle: vi.fn(),
  selectComposition: vi.fn(),
  renderMedia: vi.fn(),
}));
vi.mock('@remotion/bundler', () => ({ bundle: remotion.bundle }));
vi.mock('@remotion/renderer', () => ({
  selectComposition: remotion.selectComposition,
  renderMedia: remotion.renderMedia,
}));

const { REMOTION_ENTRY, mediaFiles, renderVideos, wavSamples } = await import('@/lib/render/local');

/** The 9:16 voice of the audit: -19.2 LUFS, -4.8 dBFS once in stereo. */
const quietVoice = vi.fn(async () => ({ loudnessLufs: -19.2, peakDbfs: -4.8 }));

function props(format: VideoProps['format'], extra: Partial<VideoProps> = {}): VideoProps {
  return {
    format,
    variant: format === '9x16' ? 'social' : 'listing',
    vertical: 'auto',
    fps: 30,
    durationInFrames: 300,
    photos: [
      { src: 'photo-01.jpg', role: 'trois-quarts avant', width: 1600, height: 1066 },
      { src: 'photo-02.jpg', role: 'profil', width: 1600, height: 1066 },
    ],
    subtitles: [],
    overlays: { title: 'Peugeot 308' },
    watermark: true,
    ...extra,
  };
}

let root: string;
let publicDir: string;
let bundleDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'render-local-test-'));
  publicDir = join(root, 'public');
  bundleDir = join(root, 'bundle');
  await mkdir(publicDir);
  for (const name of ['photo-01.jpg', 'photo-02.jpg', 'voix.mp3']) await writeFile(join(publicDir, name), 'x');
  remotion.bundle.mockImplementation(async () => {
    await mkdir(bundleDir);
    return bundleDir;
  });
  remotion.selectComposition.mockImplementation(async ({ id }: { id: string }) => ({ id }));
  remotion.renderMedia.mockResolvedValue({});
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('mediaFiles', () => {
  it('lists the photos, then the voice and the music when present', () => {
    expect(mediaFiles(props('9x16'))).toEqual(['photo-01.jpg', 'photo-02.jpg']);
    expect(mediaFiles(props('9x16', { voiceSrc: 'voix.mp3', musicSrc: 'musique.mp3' }))).toEqual([
      'photo-01.jpg',
      'photo-02.jpg',
      'voix.mp3',
      'musique.mp3',
    ]);
  });
});

describe('renderVideos', () => {
  it('does nothing without jobs', async () => {
    expect(await renderVideos({ jobs: [], publicDir })).toEqual([]);
    expect(remotion.bundle).not.toHaveBeenCalled();
  });

  it('fails before bundling when a media file is missing from the public dir', async () => {
    const jobs = [{ props: props('9x16', { voiceSrc: 'voix-absente.mp3' }), outputPath: join(root, 'a.mp4') }];
    await expect(renderVideos({ jobs, publicDir })).rejects.toThrow(
      'Fichier média absent du dossier public : voix-absente.mp3',
    );
    expect(remotion.bundle).not.toHaveBeenCalled();
  });

  it('bundles once, renders each format with its composition as H.264, then removes the bundle', async () => {
    vi.stubEnv('REMOTION_BROWSER_EXECUTABLE', '/opt/chrome/headless_shell');
    const vertical = props('9x16', { voiceSrc: 'voix.mp3' });
    const horizontal = props('16x9');
    const jobs = [
      { props: vertical, outputPath: join(root, 'out', 'video-9x16.mp4') },
      { props: horizontal, outputPath: join(root, 'out', 'video-16x9.mp4') },
    ];

    const results = await renderVideos({ jobs, publicDir, concurrency: 2, measureVoice: quietVoice });

    expect(results.map((r) => r.outputPath)).toEqual(jobs.map((j) => j.outputPath));
    expect(remotion.bundle).toHaveBeenCalledTimes(1);
    expect(remotion.bundle).toHaveBeenCalledWith(
      expect.objectContaining({ entryPoint: REMOTION_ENTRY, publicDir: resolve(publicDir) }),
    );
    // +3.2 dB on the voice brings it to -16 LUFS; the silent 16:9 is left as it is.
    const louder = { ...vertical, voiceVolume: 1.445 };
    expect(quietVoice).toHaveBeenCalledExactlyOnceWith(join(publicDir, 'voix.mp3'));
    expect(results[0]?.voice).toEqual({ loudnessLufs: -19.2, peakDbfs: -4.8, gainDb: expect.closeTo(3.2, 6) });
    expect(results[1]?.voice).toBeUndefined();
    expect(remotion.selectComposition.mock.calls.map(([o]) => [o.id, o.inputProps])).toEqual([
      ['ListingVertical', louder],
      ['ListingHorizontal', horizontal],
    ]);
    expect(remotion.renderMedia).toHaveBeenCalledTimes(2);
    const [first] = remotion.renderMedia.mock.calls[0]!;
    expect(first).toMatchObject({
      composition: { id: 'ListingVertical' },
      serveUrl: bundleDir,
      codec: 'h264',
      colorSpace: 'bt709',
      outputLocation: resolve(jobs[0]!.outputPath),
      inputProps: louder,
      browserExecutable: '/opt/chrome/headless_shell',
      concurrency: 2,
    });
    expect(existsSync(join(root, 'out'))).toBe(true);
    expect(existsSync(bundleDir)).toBe(false);
  });

  it('keeps a voice volume set by the props and measures each voice file once', async () => {
    const set = props('9x16', { voiceSrc: 'voix.mp3', voiceVolume: 0.8 });
    await renderVideos({ jobs: [{ props: set, outputPath: join(root, 'a.mp4') }], publicDir, measureVoice: quietVoice });
    expect(quietVoice).not.toHaveBeenCalled();
    expect(remotion.renderMedia.mock.calls[0]![0].inputProps).toEqual(set);

    const shared = props('9x16', { voiceSrc: 'voix.mp3' });
    const jobs = [
      { props: shared, outputPath: join(root, 'b.mp4') },
      { props: { ...shared, format: '16x9' as const }, outputPath: join(root, 'c.mp4') },
    ];
    await renderVideos({ jobs, publicDir, measureVoice: quietVoice });
    expect(quietVoice).toHaveBeenCalledTimes(1);
  });

  it('keeps the volume set by the props of a job when another job measures the same voice', async () => {
    const set = props('9x16', { voiceSrc: 'voix.mp3', voiceVolume: 0.8 });
    const unset = props('16x9', { voiceSrc: 'voix.mp3' });
    const jobs = [
      { props: set, outputPath: join(root, 'a.mp4') },
      { props: unset, outputPath: join(root, 'b.mp4') },
    ];
    const results = await renderVideos({ jobs, publicDir, measureVoice: quietVoice });
    expect(quietVoice).toHaveBeenCalledTimes(1);
    expect(remotion.renderMedia.mock.calls.map(([o]) => o.inputProps.voiceVolume)).toEqual([0.8, 1.445]);
    expect(results[0]?.voice).toBeUndefined();
    expect(results[1]?.voice?.gainDb).toBeCloseTo(3.2, 6);
  });

  it('fails before bundling when the voice cannot be measured', async () => {
    const jobs = [{ props: props('9x16', { voiceSrc: 'voix.mp3' }), outputPath: join(root, 'a.mp4') }];
    const broken = vi.fn(async () => {
      throw new Error('Lecture de la voix impossible (voix.mp3) : Invalid data found when processing input');
    });
    await expect(renderVideos({ jobs, publicDir, measureVoice: broken })).rejects.toThrow('Lecture de la voix impossible');
    expect(remotion.bundle).not.toHaveBeenCalled();
  });

  it('removes the bundle when a render fails', async () => {
    remotion.renderMedia.mockRejectedValueOnce(new Error('Chrome a planté'));
    const jobs = [{ props: props('16x9'), outputPath: join(root, 'video.mp4') }];
    await expect(renderVideos({ jobs, publicDir, browserExecutable: '/bin/chrome' })).rejects.toThrow('Chrome a planté');
    expect(remotion.selectComposition).toHaveBeenCalledWith(expect.objectContaining({ browserExecutable: '/bin/chrome' }));
    expect(existsSync(bundleDir)).toBe(false);
  });
});

describe('wavSamples', () => {
  /** A 16-bit PCM WAV as ffmpeg writes it to a pipe: a LIST chunk, and no data size. */
  function pipedWav(channels: number, samples: number[]): Buffer {
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'latin1');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(48_000, 12);
    fmt.writeUInt32LE(48_000 * channels * 2, 16);
    fmt.writeUInt16LE(channels * 2, 20);
    fmt.writeUInt16LE(16, 22);
    const list = Buffer.concat([Buffer.from('LIST', 'latin1'), Buffer.from([5, 0, 0, 0]), Buffer.from('INFOx\0', 'latin1')]);
    const data = Buffer.alloc(8 + samples.length * 2);
    data.write('data', 0, 'latin1');
    data.writeUInt32LE(0xffffffff, 4);
    samples.forEach((v, i) => data.writeInt16LE(v, 8 + 2 * i));
    const header = Buffer.from('RIFF\xff\xff\xff\xffWAVE', 'latin1');
    return Buffer.concat([header, fmt, list, data]);
  }

  it('reads the samples to the end of the file, in [-1, 1)', () => {
    const { samples, channels } = wavSamples(pipedWav(2, [0, 16384, -32768, 32767]));
    expect(channels).toBe(2);
    expect(Array.from(samples)).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it('refuses what is not a 16-bit WAV', () => {
    expect(() => wavSamples(Buffer.from('ID3 not a wav file'))).toThrow('Fichier WAV invalide');
    const wav = pipedWav(1, [1, 2]);
    wav.writeUInt16LE(24, 12 + 22);
    expect(() => wavSamples(wav)).toThrow('WAV en 24 bits, 16 attendus');
  });
});
