import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
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
};

export type RenderResult = { outputPath: string; durationMs: number };

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
 * Bundles the compositions once, then renders each job to an H.264 MP4, one after the
 * other. Chrome keeps its default GL backend: "swangle" rendered 3 to 4 times slower
 * on a 4-CPU machine without GPU.
 */
export async function renderVideos(options: RenderOptions): Promise<RenderResult[]> {
  const { jobs, publicDir, concurrency, onProgress } = options;
  const browserExecutable = options.browserExecutable ?? (process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || undefined);
  // Free License: up to 3 people in the company (checked at install, CLAUDE.md). A Company
  // License key from remotion.pro goes in REMOTION_LICENSE_KEY and counts the renders.
  const licenseKey = process.env.REMOTION_LICENSE_KEY?.trim() || 'free-license';
  if (jobs.length === 0) return [];
  await checkMedia(jobs, publicDir);

  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir: resolve(publicDir),
    onProgress: (percent) => onProgress?.({ stage: 'bundle', progress: percent / 100 }),
  });

  try {
    const results: RenderResult[] = [];
    for (const { props, outputPath } of jobs) {
      const started = Date.now();
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
        outputLocation: resolve(outputPath),
        inputProps,
        browserExecutable,
        concurrency: concurrency ?? null,
        licenseKey,
        onProgress: ({ progress }) => onProgress?.({ stage: 'render', outputPath, progress }),
      });
      results.push({ outputPath, durationMs: Date.now() - started });
    }
    return results;
  } finally {
    // The bundle is a temporary folder holding a copy of the public dir.
    await rm(serveUrl, { recursive: true, force: true });
  }
}
