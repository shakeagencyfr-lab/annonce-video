import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeVideo, type MakeVideoDeps } from '@/lib/pipeline/make-video';
import type { Variant, VideoScript, Voiceover } from '@/lib/pipeline/types';
import { estimateVoiceover } from '@/lib/pipeline/voice';
import type { RenderOptions } from '@/lib/render/local';
import { cleanAnswer, fakeClaude } from './script-helpers';

const SHEET = join(__dirname, '../fixtures/sheets/auto-308.json');

let dir: string;
let photosDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'make-video-'));
  photosDir = join(dir, 'photos');
  await import('node:fs/promises').then((fs) => fs.mkdir(photosDir));
  for (let i = 0; i < 10; i++) {
    const img = await sharp({ create: { width: 1600, height: 1066, channels: 3, background: { r: 20 * i, g: 80, b: 160 } } })
      .jpeg()
      .toBuffer();
    await writeFile(join(photosDir, `p${i}.jpg`), img);
  }
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
  vi.stubEnv('ELEVENLABS_VOICE_ID_FR', 'voice-fr');
  vi.stubEnv('ELEVENLABS_USD_PER_1K_CHARS', '0.3');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** durations: voice length per variant; by default the estimate from the script. */
function fakes(durations: Partial<Record<Variant, number>> = {}) {
  const selection = {
    selected: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index, i) => ({
      index,
      role: ['trois-quarts avant', 'profil', 'arrière', 'intérieur', 'tableau de bord', 'détail', 'détail', 'détail', 'autre'][i],
    })),
    rejected: [{ index: 9, reason: 'doublon de la photo 0' }],
  };
  const { client, calls } = fakeClaude({
    'claude-sonnet-5': [{ json: selection }, { json: cleanAnswer() }],
    'claude-haiku-4-5-20251001': [{ json: { unsupported: [] } }],
  });
  const ttsCalls: { script: VideoScript; voiceId: string }[] = [];
  const synthesize: NonNullable<MakeVideoDeps['synthesize']> = async (script, deps) => {
    ttsCalls.push({ script, voiceId: deps.voiceId });
    const audioPath = join(deps.outDir, `voice-${script.variant}.mp3`);
    await writeFile(audioPath, 'fake mp3');
    const estimate = estimateVoiceover(script);
    const voiceover: Voiceover = { ...estimate, audioPath, durationSec: durations[script.variant] ?? estimate.durationSec };
    const text = script.segments.map((s) => s.text).join(' ');
    return { voiceover, usage: { step: 'voix', model: 'eleven_multilingual_v2', ttsCharacters: text.length, costUsd: (text.length / 1000) * 0.3 } };
  };
  const renders: RenderOptions[] = [];
  const renderVideos: NonNullable<MakeVideoDeps['renderVideos']> = async (options) => {
    renders.push(options);
    return options.jobs.map((j) => ({ outputPath: j.outputPath, durationMs: 1 }));
  };
  return { deps: { client, synthesize, renderVideos }, calls, ttsCalls, renders };
}

describe('makeVideo (online path, with fakes)', () => {
  it('chains photos, checked scripts, voice and render, and totals the real cost', async () => {
    const f = fakes();
    const logs: string[] = [];
    const result = await makeVideo(
      {
        source: SHEET,
        language: 'fr',
        outRoot: join(dir, 'out'),
        offline: false,
        photosDir,
        preview: true,
        variants: ['social', 'listing'],
        log: (l) => logs.push(l),
      },
      f.deps,
    );

    // Claude: photo sorting and script on Sonnet 5, judge on Haiku 4.5.
    expect(f.calls.map((c) => c.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(f.ttsCalls.map((c) => [c.script.variant, c.voiceId])).toEqual([
      ['social', 'voice-fr'],
      ['listing', 'voice-fr'],
    ]);

    const [render] = f.renders;
    const [social, listing] = render?.jobs ?? [];
    expect(social?.props.format).toBe('9x16');
    expect(listing?.props.format).toBe('16x9');
    expect(social?.props.photos).toHaveLength(9);
    expect(social?.props.photos[0]).toMatchObject({ src: 'photo-0.jpg', role: 'trois-quarts avant' });
    expect(social?.props.voiceSrc).toBe('voice-social.mp3');
    expect(listing?.props.voiceSrc).toBe('voice-listing.mp3');
    expect(social?.props.overlays.price).toBeDefined();
    expect(listing?.props.overlays.price).toBeUndefined();
    expect(listing?.props.overlays.contact).toBeUndefined();
    expect(social?.props.watermark).toBe(true);
    expect(social?.props.subtitles.length).toBeGreaterThan(3);
    expect(social?.props.durationInFrames).toBeGreaterThan(30 * 20);

    expect(result.costs.lines.map((l) => l.step)).toEqual(['photos', 'script', 'script', 'voix', 'voix', 'rendu']);
    expect(result.costs.claudeCostUsd).toBeGreaterThan(0);
    expect(result.costs.ttsCostUsd).toBeGreaterThan(0);
    expect(result.costs.totalUsd).toBeCloseTo(result.costs.claudeCostUsd + result.costs.ttsCostUsd);

    const saved = JSON.parse(await readFile(join(result.workDir, 'fiche.json'), 'utf8'));
    expect(saved.title).toContain('Peugeot 308');
    expect(logs.join('\n')).toContain('écartée 9 : doublon de la photo 0');
  });

  it('asks for the voice id of the requested language', async () => {
    const f = fakes();
    vi.stubEnv('ELEVENLABS_VOICE_ID_FR', '');
    await expect(
      makeVideo(
        { source: SHEET, language: 'fr', outRoot: join(dir, 'out'), offline: false, photosDir, preview: false, variants: ['social'], log: () => {} },
        f.deps,
      ),
    ).rejects.toThrow(/ELEVENLABS_VOICE_ID_FR/);
  });

  it('logs a missing DPE on a property listing and shows none (rule 5)', async () => {
    const f = fakes();
    const immo = join(dir, 'immo.json');
    await writeFile(
      immo,
      JSON.stringify({
        vertical: 'immo',
        platform: 'seloger',
        sourceUrl: 'https://www.seloger.com/annonce/achat/a/b/c/26ZCAGW19827',
        transaction: 'vente',
        propertyType: 'Appartement',
        currency: 'EUR',
        city: 'Marseille',
        features: [],
        photos: [],
      }),
    );
    const logs: string[] = [];
    const result = await makeVideo(
      { source: immo, language: 'fr', outRoot: join(dir, 'out'), offline: true, photosDir, preview: false, variants: ['listing'], log: (l) => logs.push(l) },
      f.deps,
    );
    expect(result.warnings.some((w) => w.includes('DPE absente'))).toBe(true);
    expect(logs.join('\n')).toContain('DPE absente');
    expect(f.renders[0]?.jobs[0]?.props.dpe).toBeUndefined();
  });

  it('runs offline without any Claude or TTS call', async () => {
    const f = fakes();
    const result = await makeVideo(
      { source: SHEET, language: 'fr', outRoot: join(dir, 'out'), offline: true, photosDir, preview: false, variants: ['listing'], log: () => {} },
      f.deps,
    );
    expect(f.calls).toHaveLength(0);
    expect(f.ttsCalls).toHaveLength(0);
    expect(f.renders[0]?.jobs[0]?.props.voiceSrc).toBeUndefined();
    expect(result.costs.totalUsd).toBe(0);
    // The template voice is short: the estimate misses the 30-40 s target, and says so.
    expect(result.warnings).toEqual([expect.stringMatching(/^\[listing\] durée cible manquée : voix de \d+\.\d s \(estimée\), pour 30 à 40 s attendues$/)]);
  });

  it('offline, keeps an evenly spaced sample of all the photos, not the first ones', async () => {
    const many = join(dir, 'many');
    await import('node:fs/promises').then((fs) => fs.mkdir(many));
    const img = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#468' } }).jpeg().toBuffer();
    // 23 photos: more than the old 20-photo cap, and not a multiple of the 10 kept.
    for (let i = 0; i < 23; i++) await writeFile(join(many, `p${String(i).padStart(2, '0')}.jpg`), img);
    const f = fakes();
    const logs: string[] = [];
    await makeVideo(
      { source: SHEET, language: 'fr', outRoot: join(dir, 'out'), offline: true, photosDir: many, preview: false, variants: ['listing'], log: (l) => logs.push(l) },
      f.deps,
    );
    // Positions round(i * 23 / 10), i = 0..9.
    const kept = [0, 2, 5, 7, 9, 12, 14, 16, 18, 21];
    expect(f.renders[0]?.jobs[0]?.props.photos.map((p) => p.src)).toEqual(kept.map((i) => `photo-${i}.jpg`));
    const rejected = logs.filter((l) => l.includes('écartée')).map((l) => Number(/écartée (\d+)/.exec(l)?.[1]));
    expect(rejected).toEqual(Array.from({ length: 23 }, (_, i) => i).filter((i) => !kept.includes(i)));
    expect(logs).toContain('    écartée 22 : hors de l’échantillon régulier retenu (mode hors ligne)');
  });

  it('warns when a voice is outside the target duration, bounds included in the target', async () => {
    const f = fakes({ social: 29.9, listing: 30 });
    const result = await makeVideo(
      { source: SHEET, language: 'fr', outRoot: join(dir, 'out'), offline: false, photosDir, preview: false, variants: ['social', 'listing'], log: () => {} },
      f.deps,
    );
    expect(result.warnings).toEqual(['[social] durée cible manquée : voix de 29.9 s, pour 30 à 40 s attendues']);

    const long = fakes({ social: 40, listing: 40.1 });
    const again = await makeVideo(
      { source: SHEET, language: 'fr', outRoot: join(dir, 'out'), offline: false, photosDir, preview: false, variants: ['social', 'listing'], log: () => {} },
      long.deps,
    );
    expect(again.warnings).toEqual(['[listing] durée cible manquée : voix de 40.1 s, pour 30 à 40 s attendues']);
  });
});
