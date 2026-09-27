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

const { REMOTION_ENTRY, mediaFiles, renderVideos } = await import('@/lib/render/local');

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

    const results = await renderVideos({ jobs, publicDir, concurrency: 2 });

    expect(results.map((r) => r.outputPath)).toEqual(jobs.map((j) => j.outputPath));
    expect(remotion.bundle).toHaveBeenCalledTimes(1);
    expect(remotion.bundle).toHaveBeenCalledWith(
      expect.objectContaining({ entryPoint: REMOTION_ENTRY, publicDir: resolve(publicDir) }),
    );
    expect(remotion.selectComposition.mock.calls.map(([o]) => [o.id, o.inputProps])).toEqual([
      ['ListingVertical', vertical],
      ['ListingHorizontal', horizontal],
    ]);
    expect(remotion.renderMedia).toHaveBeenCalledTimes(2);
    const [first] = remotion.renderMedia.mock.calls[0]!;
    expect(first).toMatchObject({
      composition: { id: 'ListingVertical' },
      serveUrl: bundleDir,
      codec: 'h264',
      outputLocation: resolve(jobs[0]!.outputPath),
      inputProps: vertical,
      browserExecutable: '/opt/chrome/headless_shell',
      concurrency: 2,
    });
    expect(existsSync(join(root, 'out'))).toBe(true);
    expect(existsSync(bundleDir)).toBe(false);
  });

  it('removes the bundle when a render fails', async () => {
    remotion.renderMedia.mockRejectedValueOnce(new Error('Chrome a planté'));
    const jobs = [{ props: props('16x9'), outputPath: join(root, 'video.mp4') }];
    await expect(renderVideos({ jobs, publicDir, browserExecutable: '/bin/chrome' })).rejects.toThrow('Chrome a planté');
    expect(remotion.selectComposition).toHaveBeenCalledWith(expect.objectContaining({ browserExecutable: '/bin/chrome' }));
    expect(existsSync(bundleDir)).toBe(false);
  });
});
