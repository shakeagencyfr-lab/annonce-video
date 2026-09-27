import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ELEVENLABS_MODEL, MODELS, requireEnv } from '../config';
import { summarizeCosts, type CostSummary } from '../costs';
import { readSource } from '../readers';
import { renderVideos } from '../render/local';
import { COMPOSITION_ID, DIMENSIONS, FPS, type VideoProps } from '../render/props';
import type { Sheet } from '../sheet';
import { loadLocalPhotos } from './local-photos';
import { downloadPhotos, selectPhotos } from './photos';
import { produceCheckedScripts } from './script';
import { buildCues } from './subtitles';
import { templateScripts } from './template-script';
import {
  DURATION_SEC,
  FORMAT_OF_VARIANT,
  PHOTO_COUNT,
  type ClaudeClient,
  type Language,
  type LocalPhoto,
  type PhotoSelection,
  type UsageLine,
  type Variant,
  type VideoScript,
  type Voiceover,
} from './types';
import { estimateVoiceover, synthesize } from './voice';

export type MakeVideoOptions = {
  /** Listing URL, exported listing (.json) or sheet (.json). */
  source: string;
  language: Language;
  outRoot: string;
  /** No Claude, no TTS: template scripts, estimated timings, silent videos. */
  offline: boolean;
  /** Local photo folder used instead of the listing's photos. */
  photosDir?: string;
  /** Royalty-free music with a commercial license (rule 6). */
  musicPath?: string;
  /** Watermarked preview (the paid HD version has none). */
  preview: boolean;
  variants: Variant[];
  log: (line: string) => void;
};

/** Replaceable dependencies, for tests: the real ones call Claude, ElevenLabs and Remotion. */
export type MakeVideoDeps = {
  client?: ClaudeClient;
  synthesize?: typeof synthesize;
  renderVideos?: typeof renderVideos;
};

export type MakeVideoResult = {
  workDir: string;
  sheet: Sheet;
  videos: { variant: Variant; path: string }[];
  costs: CostSummary;
  warnings: string[];
};

/** Tail kept after the last word so the end card is readable. */
const END_PADDING_SEC = 1.5;

function slug(sheet: Sheet): string {
  const id = /(\d{6,}|[0-9a-f-]{36}|[A-Z0-9]{10,})\/?$/i.exec(new URL(sheet.sourceUrl).pathname)?.[1] ?? 'annonce';
  return `${sheet.platform}-${id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function offlineSelection(photos: LocalPhoto[], sheet: Sheet): PhotoSelection {
  const max = PHOTO_COUNT[sheet.vertical].max;
  return {
    selected: photos.slice(0, max).map((p) => ({ ...p, role: 'autre' as const })),
    rejected: photos.slice(max).map((p) => ({ index: p.index, reason: 'au-delà du nombre de photos retenues (mode hors ligne)' })),
  };
}

function videoProps(
  script: VideoScript,
  voice: Voiceover,
  selection: PhotoSelection,
  sheet: Sheet,
  opts: { voiceFile?: string; musicFile?: string; preview: boolean },
): VideoProps {
  const format = FORMAT_OF_VARIANT[script.variant];
  return {
    format,
    variant: script.variant,
    vertical: sheet.vertical,
    fps: FPS,
    durationInFrames: Math.ceil((voice.durationSec + END_PADDING_SEC) * FPS),
    photos: selection.selected.map((p) => ({ src: basename(p.path), role: p.role, width: p.width, height: p.height })),
    ...(opts.voiceFile ? { voiceSrc: opts.voiceFile } : {}),
    ...(opts.musicFile ? { musicSrc: opts.musicFile } : {}),
    subtitles: buildCues(voice.words, format),
    overlays: script.overlays,
    ...(sheet.vertical === 'immo' && sheet.dpe ? { dpe: sheet.dpe } : {}),
    watermark: opts.preview,
  };
}

/**
 * Step 1 prototype: listing -> sheet -> photos -> script -> voice -> two MP4s, with the
 * real cost of each step. Everything the videos say comes from the sheet (rule 3).
 */
export async function makeVideo(options: MakeVideoOptions, deps: MakeVideoDeps = {}): Promise<MakeVideoResult> {
  const { log } = options;
  const tts = deps.synthesize ?? synthesize;
  const render = deps.renderVideos ?? renderVideos;
  const usage: UsageLine[] = [];
  const warnings: string[] = [];

  log('1/6 Lecture de l’annonce');
  const { sheet, origin } = await readSource(options.source);
  log(`    ${sheet.vertical === 'auto' ? sheet.title : sheet.propertyType} (${sheet.platform}, ${origin}), ${sheet.photos.length} photo(s) dans la fiche`);
  if (sheet.vertical === 'immo' && !sheet.dpe) {
    // Rule 5: no DPE in the listing -> nothing shown in the video, and logged.
    warnings.push('classe DPE absente de l’annonce : rien n’est affiché dans la vidéo');
    log('    ⚠ classe DPE absente de l’annonce : rien n’est affiché');
  }

  const workDir = resolve(options.outRoot, `${slug(sheet)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const publicDir = join(workDir, 'public');
  await mkdir(publicDir, { recursive: true });
  // The sheet is kept for regenerations, then purged (rule 2); never the page itself.
  await writeFile(join(workDir, 'fiche.json'), JSON.stringify(sheet, null, 2));

  log('2/6 Photos');
  let photos: LocalPhoto[];
  if (options.photosDir) {
    photos = await loadLocalPhotos(options.photosDir, publicDir);
    log(`    ${photos.length} photo(s) locale(s) depuis ${options.photosDir}`);
  } else {
    const downloaded = await downloadPhotos(sheet, publicDir);
    photos = downloaded.photos;
    for (const f of downloaded.failures) warnings.push(`photo ${f.index} non téléchargée : ${f.reason}`);
    log(`    ${photos.length} photo(s) téléchargée(s), ${downloaded.failures.length} échec(s)`);
  }
  if (photos.length === 0) throw new Error('Aucune photo utilisable : impossible de faire une vidéo');

  const client: ClaudeClient | null = options.offline ? null : (deps.client ?? new Anthropic());
  let selection: PhotoSelection;
  if (client) {
    const result = await selectPhotos(photos, sheet, { client, model: MODELS.photos });
    selection = result.selection;
    usage.push(result.usage);
  } else {
    selection = offlineSelection(photos, sheet);
  }
  log(`    ${selection.selected.length} retenue(s) : ${selection.selected.map((p) => `${p.index} ${p.role}`).join(', ')}`);
  for (const r of selection.rejected) log(`    écartée ${r.index} : ${r.reason}`);
  if (selection.selected.length < PHOTO_COUNT[sheet.vertical].min) {
    warnings.push(`${selection.selected.length} photo(s) retenue(s), moins que les ${PHOTO_COUNT[sheet.vertical].min} prévues`);
  }

  log('3/6 Script');
  let scripts: Record<Variant, VideoScript>;
  if (client) {
    const result = await produceCheckedScripts(sheet, selection, { client, language: options.language, model: MODELS.script });
    scripts = result.scripts;
    usage.push(...result.usage);
  } else {
    scripts = templateScripts(sheet, options.language);
  }
  for (const v of options.variants) {
    log(`    [${v}] ${scripts[v].segments.map((s) => s.text).join(' ')}`);
  }
  await writeFile(join(workDir, 'scripts.json'), JSON.stringify(scripts, null, 2));

  log('4/6 Voix off');
  const voices = new Map<Variant, { voice: Voiceover; file?: string }>();
  for (const v of options.variants) {
    if (options.offline) {
      voices.set(v, { voice: estimateVoiceover(scripts[v], {}) });
      continue;
    }
    const voiceIdVar = `ELEVENLABS_VOICE_ID_${options.language.toUpperCase()}`;
    const result = await tts(scripts[v], {
      apiKey: requireEnv('ELEVENLABS_API_KEY'),
      voiceId: requireEnv(voiceIdVar),
      outDir: publicDir,
      model: ELEVENLABS_MODEL,
    });
    usage.push(result.usage);
    voices.set(v, { voice: result.voiceover, file: basename(result.voiceover.audioPath) });
  }
  for (const [v, { voice }] of voices) {
    const target = DURATION_SEC[sheet.vertical];
    log(`    [${v}] ${voice.durationSec.toFixed(1)} s${options.offline ? ' (estimée, vidéo muette)' : ''}`);
    if (voice.durationSec < target.min - 5 || voice.durationSec > target.max + 5) {
      warnings.push(`[${v}] voix de ${voice.durationSec.toFixed(1)} s, hors de la cible ${target.min}-${target.max} s`);
    }
  }

  let musicFile: string | undefined;
  if (options.musicPath) {
    musicFile = `music${options.musicPath.slice(options.musicPath.lastIndexOf('.'))}`;
    const { copyFile } = await import('node:fs/promises');
    await copyFile(options.musicPath, join(publicDir, musicFile));
  }

  log('5/6 Rendu');
  const jobs = options.variants.map((v) => {
    const voice = voices.get(v);
    if (!voice) throw new Error(`voix manquante pour ${v}`);
    const props = videoProps(scripts[v], voice.voice, selection, sheet, {
      voiceFile: voice.file,
      musicFile,
      preview: options.preview,
    });
    const { width, height } = DIMENSIONS[props.format];
    log(`    [${v}] ${COMPOSITION_ID[props.format]} ${width}×${height}, ${(props.durationInFrames / FPS).toFixed(1)} s`);
    return { props, outputPath: join(workDir, `video-${props.format}.mp4`) };
  });
  const rendered = await render({ jobs, publicDir });
  usage.push({ step: 'rendu', model: 'remotion (local)', costUsd: 0 });

  log('6/6 Coût');
  const costs = summarizeCosts(usage);
  await writeFile(join(workDir, 'costs.json'), JSON.stringify(costs, null, 2));

  return {
    workDir,
    sheet,
    videos: rendered.map((r, i) => ({ variant: options.variants[i] as Variant, path: r.outputPath })),
    costs,
    warnings,
  };
}
