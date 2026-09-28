import { spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { RenderInternals, renderMedia, selectComposition } from '@remotion/renderer';
import { type AudioLevel, dbToGain, LOUDNESS_SAMPLE_RATE, measureLevel, voiceGainDb } from './loudness';
import { COMPOSITION_ID, type VideoProps } from './props';

/**
 * Local render of the Remotion compositions (step 1, CLI). The site will render on
 * Remotion Lambda instead; this path needs Chrome Headless Shell and ffmpeg, both
 * provided by @remotion/renderer (or REMOTION_BROWSER_EXECUTABLE when Remotion
 * cannot download its browser).
 */

export type RenderJob = { props: VideoProps; outputPath: string };

export type RenderProgress =
  | { stage: 'bundle'; progress: number }
  | { stage: 'render'; outputPath: string; progress: number };

export type RenderOptions = {
  jobs: RenderJob[];
  /** Folder served to the compositions: every media path of the props is a file in it. */
  publicDir: string;
  browserExecutable?: string;
  /** Frames rendered in parallel (Remotion's default: half of the CPU cores). */
  concurrency?: number;
  onProgress?: (progress: RenderProgress) => void;
  /** Level of a voice-over file as the render mixes it; ffmpeg by default, a fake in tests. */
  measureVoice?: (path: string) => Promise<AudioLevel>;
};

/** Voice-over level measured before the render, and the gain applied to reach the target. */
export type VoiceLevel = AudioLevel & { gainDb: number };

export type RenderResult = { outputPath: string; durationMs: number; voice?: VoiceLevel };

/** The CLI runs from the repository root (npm run, tsx). */
export const REMOTION_ENTRY = resolve(process.cwd(), 'remotion/index.ts');

/** Files the props load with staticFile(), relative to the public dir. */
export function mediaFiles(props: VideoProps): string[] {
  const files = props.photos.map((photo) => photo.src);
  if (props.voiceSrc) files.push(props.voiceSrc);
  if (props.musicSrc) files.push(props.musicSrc);
  return files;
}

/**
 * Fails before the (slow) bundle when a media file is missing. Remotion would only
 * warn for a missing voice-over and render a silent video.
 */
async function checkMedia(jobs: RenderJob[], publicDir: string): Promise<void> {
  for (const src of new Set(jobs.flatMap((job) => mediaFiles(job.props)))) {
    try {
      await access(join(publicDir, src));
    } catch {
      throw new Error(`Fichier média absent du dossier public : ${src}`);
    }
  }
}

/**
 * Samples of a 16-bit PCM WAV file, in [-1, 1). Written to a pipe, the file does not
 * give the size of its data chunk: the data runs to the end.
 */
export function wavSamples(wav: Buffer): { samples: Float32Array; channels: number } {
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Fichier WAV invalide');
  }
  let channels = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(offset + 10);
      const bits = wav.readUInt16LE(offset + 22);
      if (bits !== 16) throw new Error(`WAV en ${bits} bits, 16 attendus`);
    } else if (id === 'data') {
      if (channels < 1) throw new Error('WAV sans en-tête « fmt »');
      const start = offset + 8;
      const count = Math.floor((wav.length - start) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = wav.readInt16LE(start + 2 * i) / 32768;
      return { samples, channels };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV sans données');
}

/**
 * Level of an audio file as the render mixes it: Remotion's ffmpeg decodes every
 * track to 16-bit stereo at 48 kHz (a mono voice goes to both channels at -3 dB), so
 * the file is decoded the same way with the same ffmpeg, then measured
 * (lib/render/loudness.ts). That ffmpeg build only writes WAV among the PCM formats.
 */
export async function measureAudioFile(path: string): Promise<AudioLevel> {
  const ffmpeg = RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
  });
  const args = [
    ...['-v', 'error', '-i', resolve(path), '-vn'],
    ...['-ac', '2', '-ar', String(LOUDNESS_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', '-'],
  ];
  // Same working directory as Remotion's own calls, next to the ffmpeg libraries.
  const child = spawn(ffmpeg, args, { cwd: dirname(ffmpeg), stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((done, fail) => {
    child.on('error', fail);
    child.on('close', done);
  });
  if (code !== 0) {
    throw new Error(`Lecture de la voix impossible (${basename(path)}) : ${stderr.trim().slice(0, 300) || `code ${code}`}`);
  }
  const { samples, channels } = wavSamples(Buffer.concat(chunks));
  return measureLevel(samples, channels);
}

/** Gain of each voice-over file, so every video speaks at the same level (VOICE_TARGET_LUFS). */
async function voiceLevels(
  jobs: RenderJob[],
  publicDir: string,
  measure: (path: string) => Promise<AudioLevel>,
): Promise<Map<string, VoiceLevel>> {
  const levels = new Map<string, VoiceLevel>();
  for (const { props } of jobs) {
    const src = props.voiceSrc;
    if (!src || props.voiceVolume !== undefined || levels.has(src)) continue;
    const level = await measure(join(publicDir, src));
    levels.set(src, { ...level, gainDb: voiceGainDb(level) });
  }
  return levels;
}

/**
 * Bundles the compositions once, then renders each job to an H.264 MP4, one after the
 * other. Chrome keeps its default GL backend: "swangle" rendered 3 to 4 times slower
 * on a 4-CPU machine without GPU. The voice-over is brought to a common loudness
 * first, unless the props already set its volume.
 */
export async function renderVideos(options: RenderOptions): Promise<RenderResult[]> {
  const { jobs, publicDir, concurrency, onProgress } = options;
  const browserExecutable = options.browserExecutable ?? (process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || undefined);
  // Free License: up to 3 people in the company (checked at install, CLAUDE.md). A Company
  // License key from remotion.pro goes in REMOTION_LICENSE_KEY and counts the renders.
  const licenseKey = process.env.REMOTION_LICENSE_KEY?.trim() || 'free-license';
  if (jobs.length === 0) return [];
  await checkMedia(jobs, publicDir);
  const levels = await voiceLevels(jobs, publicDir, options.measureVoice ?? measureAudioFile);

  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir: resolve(publicDir),
    onProgress: (percent) => onProgress?.({ stage: 'bundle', progress: percent / 100 }),
  });

  try {
    const results: RenderResult[] = [];
    for (const job of jobs) {
      const { outputPath } = job;
      const started = Date.now();
      const voice = job.props.voiceSrc ? levels.get(job.props.voiceSrc) : undefined;
      // Rounded: Remotion writes the volume into an ffmpeg filter.
      const props: VideoProps = voice ? { ...job.props, voiceVolume: Number(dbToGain(voice.gainDb).toFixed(3)) } : job.props;
      const inputProps: Record<string, unknown> = props;
      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID[props.format],
        inputProps,
        browserExecutable,
      });
      await mkdir(dirname(resolve(outputPath)), { recursive: true });
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        // Converted and tagged as BT.709, limited range, instead of untagged full range.
        colorSpace: 'bt709',
        outputLocation: resolve(outputPath),
        inputProps,
        browserExecutable,
        concurrency: concurrency ?? null,
        licenseKey,
        onProgress: ({ progress }) => onProgress?.({ stage: 'render', outputPath, progress }),
      });
      results.push({ outputPath, durationMs: Date.now() - started, ...(voice ? { voice } : {}) });
    }
    return results;
  } finally {
    // The bundle is a temporary folder holding a copy of the public dir.
    await rm(serveUrl, { recursive: true, force: true });
  }
}
