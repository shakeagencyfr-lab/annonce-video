import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PHOTO_ROLES, type Format, type SubtitleCue, type Variant } from '../lib/pipeline/types';
import { renderVideos, type RenderProgress } from '../lib/render/local';
import { FPS, type VideoProps } from '../lib/render/props';

/**
 * Renders a short synthetic sample of both formats, without any key or network:
 * generated photos, fake subtitles, no voice. Checks the Remotion chain end to end.
 * Usage: npm run render-sample (REMOTION_BROWSER_EXECUTABLE if Remotion cannot
 * download its browser). Writes out/sample-9x16.mp4, out/sample-16x9.mp4 and a few
 * frames as PNG to look at the layout.
 */

const run = promisify(execFile);

const DURATION_SEC = 12;
const OUT_DIR = resolve(process.cwd(), 'out');
/** Title card, middle (price badge, subtitle), end card. */
const FRAMES_AT_SEC = [1, 5.5, 11];

/** Photo sizes: mostly landscape like car listings, one 4:3 and one portrait. */
const PHOTO_SIZES: [number, number][] = [
  [1600, 1066],
  [1600, 1066],
  [1600, 1066],
  [1066, 1600],
  [1600, 1066],
  [1024, 768],
  [1600, 1066],
  [1600, 1066],
];

const GRADIENTS: [string, string][] = [
  ['#1d4e89', '#00b2ca'],
  ['#7d2e68', '#f15bb5'],
  ['#264653', '#2a9d8f'],
  ['#e76f51', '#f4a261'],
  ['#3a0ca3', '#4cc9f0'],
  ['#606c38', '#dda15e'],
  ['#9d0208', '#faa307'],
  ['#495057', '#dee2e6'],
];

/** A gradient with a white frame at its edges (to see crops) and a big label. */
function photoSvg(n: number, width: number, height: number, [from, to]: [string, string]): string {
  const label = Math.round(Math.min(width, height) * 0.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="#fff" stroke-width="24"/>
  <circle cx="${width * 0.22}" cy="${height * 0.28}" r="${label * 0.45}" fill="#fff" fill-opacity="0.35"/>
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif"
    font-weight="bold" font-size="${label}" fill="#fff">PHOTO ${n}</text>
  <text x="50%" y="${height * 0.5 + label * 0.9}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif"
    font-size="${Math.round(label * 0.3)}" fill="#fff" fill-opacity="0.85">${width}×${height}</text>
</svg>`;
}

async function writePhotos(publicDir: string): Promise<VideoProps['photos']> {
  const roles = PHOTO_ROLES.auto;
  return Promise.all(
    PHOTO_SIZES.map(async ([width, height], i) => {
      const src = `photo-${String(i + 1).padStart(2, '0')}.jpg`;
      const svg = photoSvg(i + 1, width, height, GRADIENTS[i % GRADIENTS.length]!);
      await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(join(publicDir, src));
      return { src, role: roles[i % roles.length]!, width, height };
    }),
  );
}

const SUBTITLE_TEXTS = [
  'Peugeot 308 Allure de 2019',
  '68 000 km, boîte manuelle',
  'Caméra de recul et CarPlay',
  'Régulateur adaptatif',
  'Garantie 12 mois',
  'Contactez Garage des Tests',
];

/** Cues spread evenly over the video, with a short gap between them. */
function sampleSubtitles(): SubtitleCue[] {
  const span = DURATION_SEC / SUBTITLE_TEXTS.length;
  return SUBTITLE_TEXTS.map((text, i) => ({ text, start: i * span + 0.1, end: (i + 1) * span - 0.1 }));
}

function sampleProps(format: Format, variant: Variant, photos: VideoProps['photos']): VideoProps {
  const social = variant === 'social';
  return {
    format,
    variant,
    vertical: 'auto',
    fps: FPS,
    durationInFrames: DURATION_SEC * FPS,
    photos,
    subtitles: sampleSubtitles(),
    overlays: {
      title: 'Peugeot 308 Allure',
      subtitle: '2019 · 68 000 km · Essence',
      ...(social ? { price: '15 990 €', contact: 'Garage des Tests · Lyon' } : {}),
    },
    watermark: true,
  };
}

/** Folder of the ffmpeg and ffprobe binaries shipped with @remotion/renderer. */
function compositorDir(): string {
  const libc = process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : '';
  return dirname(require.resolve(`@remotion/compositor-${process.platform}-${process.arch}${libc}/package.json`));
}

const binary = (name: 'ffmpeg' | 'ffprobe') =>
  join(compositorDir(), process.platform === 'win32' ? `${name}.exe` : name);

type Probe = {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  format: { duration: string };
};

async function describe(file: string): Promise<string> {
  const { stdout } = await run(binary('ffprobe'), [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
    '-of', 'json',
    file,
  ]);
  const probe = JSON.parse(stdout) as Probe;
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(probe.format.duration).toFixed(2).replace('.', ',');
  return `${basename(file)} : ${video?.width}×${video?.height}, ${duration} s, vidéo ${video?.codec_name}, ${
    audio ? `audio ${audio.codec_name}` : 'sans audio'
  }`;
}

async function extractFrames(file: string, stem: string): Promise<string[]> {
  const frames: string[] = [];
  for (const sec of FRAMES_AT_SEC) {
    const png = join(OUT_DIR, `${stem}-${sec}s.png`);
    await run(binary('ffmpeg'), ['-y', '-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', png]);
    frames.push(png);
  }
  return frames;
}

function progressLogger() {
  const last = new Map<string, number>();
  return (p: RenderProgress) => {
    const key = p.stage === 'bundle' ? 'bundle' : p.outputPath;
    const step = Math.floor(p.progress * 4);
    if ((last.get(key) ?? -1) >= step) return;
    last.set(key, step);
    const what = p.stage === 'bundle' ? 'Bundle Remotion' : `Rendu ${basename(p.outputPath)}`;
    console.log(`${what} : ${Math.round(p.progress * 100)} %`);
  };
}

async function main() {
  const publicDir = await mkdtemp(join(tmpdir(), 'annonce-video-sample-'));
  try {
    const photos = await writePhotos(publicDir);
    const jobs = [
      { props: sampleProps('9x16', 'social', photos), outputPath: join(OUT_DIR, 'sample-9x16.mp4') },
      { props: sampleProps('16x9', 'listing', photos), outputPath: join(OUT_DIR, 'sample-16x9.mp4') },
    ];
    const results = await renderVideos({ jobs, publicDir, onProgress: progressLogger() });

    console.log('');
    for (const { outputPath, durationMs } of results) {
      console.log(`${await describe(outputPath)} (rendu en ${(durationMs / 1000).toFixed(1).replace('.', ',')} s)`);
      const stem = basename(outputPath, '.mp4');
      for (const png of await extractFrames(outputPath, stem)) console.log(`  image : ${png}`);
    }
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
