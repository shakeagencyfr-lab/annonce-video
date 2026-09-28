import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateVoiceover, synthesize, voiceText, wordsFromAlignment, type Alignment } from '@/lib/pipeline/voice';
import type { VideoScript } from '@/lib/pipeline/types';

const NBSP = ' ';
const API_KEY = 'sk_test_0123456789abcdef_SECRET';
const VOICE_ID = 'voice-fr-1';
const AUDIO = Buffer.from('ID3\u0004\u0000\u0000fake mp3 frames', 'latin1');

const script: VideoScript = {
  variant: 'social',
  language: 'fr',
  segments: [
    { kind: 'hook', text: 'Peugeot 308 de 2019,', facts: ['make', 'model', 'year'] },
    { kind: 'point', text: ` 68${NBSP}000 km.`, facts: ['mileageKm'] },
  ],
  overlays: { title: 'Peugeot 308' },
};
const TEXT = `Peugeot 308 de 2019, 68${NBSP}000 km.`;

/** Alignment shaped like ElevenLabs': one entry per character, spaces included, pauses after punctuation. */
function alignmentFor(text: string, charSec = 0.07, pauseSec = 0.2): Alignment {
  const characters = [...text];
  const starts: number[] = [];
  const ends: number[] = [];
  let t = 0;
  for (const ch of characters) {
    starts.push(t);
    t += charSec;
    ends.push(t);
    if (/[,.]/.test(ch)) t += pauseSec;
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

function okBody(text = TEXT) {
  return {
    audio_base64: AUDIO.toString('base64'),
    alignment: alignmentFor(text),
    normalized_alignment: alignmentFor('Peugeot trois cent huit de deux mille dix-neuf, soixante-huit mille kilomètres.'),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'voice-test-'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(outDir, { recursive: true, force: true });
});

const deps = (fetch: typeof globalThis.fetch, extra: object = {}) => ({
  apiKey: API_KEY,
  voiceId: VOICE_ID,
  outDir,
  fetch,
  retryDelayMs: 0,
  ...extra,
});

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`non-Error thrown: ${String(err)}`);
  }
  throw new Error('expected a rejection');
}

describe('voiceText', () => {
  it('joins the segments in order with one space', () => {
    expect(voiceText(script)).toBe(TEXT);
  });
});

describe('wordsFromAlignment', () => {
  it('splits on spaces and keeps punctuation and non-breaking groups in the word', () => {
    const words = wordsFromAlignment(alignmentFor(TEXT));
    expect(words.map((w) => w.word)).toEqual(['Peugeot', '308', 'de', '2019,', `68${NBSP}000`, 'km.']);
    const [peugeot, , , year, mileage] = words;
    expect(peugeot?.start).toBe(0);
    expect(peugeot?.end).toBeCloseTo(0.49);
    // "2019," covers characters 15 to 19; "68 000" starts after the pause of the comma.
    expect(year?.start).toBeCloseTo(15 * 0.07);
    expect(year?.end).toBeCloseTo(20 * 0.07);
    expect(mileage?.start).toBeCloseTo(21 * 0.07 + 0.2);
  });

  it('keeps French spaced punctuation, currency and number groups with their word', () => {
    const words = wordsFromAlignment(alignmentFor('Prix : 15 990 € ! « Première main » 1 250 000 km'));
    expect(words.map((w) => w.word)).toEqual([
      `Prix${NBSP}:`,
      `15${NBSP}990${NBSP}€${NBSP}!`,
      `«${NBSP}Première`,
      `main${NBSP}»`,
      `1${NBSP}250${NBSP}000`,
      'km',
    ]);
    for (const w of words) expect(w.end).toBeGreaterThanOrEqual(w.start);
  });

  it('keeps separate numbers apart', () => {
    expect(wordsFromAlignment(alignmentFor('2019, 68 km')).map((w) => w.word)).toEqual(['2019,', '68', 'km']);
    // Not after a decimal separator, a letter or a four-digit year.
    expect(wordsFromAlignment(alignmentFor('1,2 130 ch A3 000 2019 000')).map((w) => w.word)).toEqual([
      '1,2',
      '130',
      'ch',
      'A3',
      '000',
      '2019',
      '000',
    ]);
  });

  it('keeps the groups of a number together after an opening mark', () => {
    expect(wordsFromAlignment(alignmentFor('Peugeot 308 (68 000 km) « 15 990 € »')).map((w) => w.word)).toEqual([
      'Peugeot',
      '308',
      `(68${NBSP}000`,
      'km)',
      `«${NBSP}15${NBSP}990${NBSP}€${NBSP}»`,
    ]);
  });
});

describe('synthesize', () => {
  it('sends the script to ElevenLabs and returns the timed words, the mp3 and the cost', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(okBody()));
    const { voiceover, usage } = await synthesize(script, deps(fetch));

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`,
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'xi-api-key': API_KEY, 'content-type': 'application/json', accept: 'application/json' });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      text: TEXT,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    expect(voiceover.variant).toBe('social');
    expect(voiceover.words.map((w) => w.word)).toEqual(['Peugeot', '308', 'de', '2019,', `68${NBSP}000`, 'km.']);
    const lastEnd = TEXT.length * 0.07 + 0.2; // one pause, after the comma, before the last character
    expect(voiceover.words.at(-1)?.end).toBeCloseTo(lastEnd);
    expect(voiceover.durationSec).toBeCloseTo(lastEnd + 0.4, 3);
    expect(voiceover.characters).toBe(TEXT.length);

    expect(voiceover.audioPath).toBe(join(outDir, 'voice-social.mp3'));
    expect(await readFile(voiceover.audioPath)).toEqual(AUDIO);

    expect(usage).toMatchObject({ step: 'voix', model: 'eleven_multilingual_v2', ttsCharacters: TEXT.length });
    expect(usage.costUsd).toBeCloseTo((TEXT.length / 1000) * 0.22);
  });

  it('sends language_code only to models that accept it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(okBody()));
    const { usage } = await synthesize(script, deps(fetch, { model: 'eleven_flash_v2_5' }));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model_id: 'eleven_flash_v2_5',
      language_code: 'fr',
    });
    expect(usage.model).toBe('eleven_flash_v2_5');
  });

  it('falls back to the normalized alignment when the alignment is missing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ ...okBody(), alignment: null }));
    const { voiceover } = await synthesize(script, deps(fetch));
    expect(voiceover.words[1]?.word).toBe('trois');
  });

  it('falls back to the normalized alignment when the alignment is empty', async () => {
    const empty = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ ...okBody(), alignment: empty }));
    const { voiceover } = await synthesize(script, deps(fetch));
    expect(voiceover.words[1]?.word).toBe('trois');
    const none = vi.fn<typeof globalThis.fetch>(async () =>
      json({ ...okBody(), alignment: empty, normalized_alignment: alignmentFor('  ') }),
    );
    expect((await errorOf(synthesize(script, deps(none)))).message).toMatch(/sans aucun mot aligné/);
  });

  it('trims the key and the voice ID before sending them', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(okBody()));
    await synthesize(script, deps(fetch, { apiKey: ` ${API_KEY}\n`, voiceId: ` ${VOICE_ID} ` }));
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/text-to-speech/${VOICE_ID}/with-timestamps`);
    expect(init?.headers).toMatchObject({ 'xi-api-key': API_KEY });
  });

  it('checks the price setting before the paid call', async () => {
    vi.stubEnv('ELEVENLABS_USD_PER_1K_CHARS', 'abc');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(okBody()));
    expect((await errorOf(synthesize(script, deps(fetch)))).message).toMatch(/ELEVENLABS_USD_PER_1K_CHARS/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed response', async () => {
    const bad = okBody();
    bad.alignment.character_end_times_seconds.pop();
    for (const body of [bad, { audio_base64: '' }, { alignment: okBody().alignment }, { ...okBody(), audio_base64: 'pas du base64 !' }]) {
      const err = await errorOf(synthesize(script, deps(vi.fn<typeof globalThis.fetch>(async () => json(body)))));
      expect(err.message).toMatch(/réponse ElevenLabs inattendue/);
    }
    const notJson = vi.fn<typeof globalThis.fetch>(async () => new Response('<html>oops</html>', { status: 200 }));
    expect((await errorOf(synthesize(script, deps(notJson)))).message).toMatch(/illisible/);
  });

  it('maps a 401 to an invalid key message', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ detail: { status: 'invalid_api_key', message: `Invalid API key: ${API_KEY}` } }, 401),
    );
    const err = await errorOf(synthesize(script, deps(fetch)));
    expect(err.message).toBe(
      "clé ElevenLabs refusée (vérifier ELEVENLABS_API_KEY, ou l'identifiant d'API de l'environnement) : Invalid API key: ***",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the API detail of a 401 that is not about the key itself', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ detail: { status: 'missing_permissions', message: 'The API key is missing the permission text_to_speech.' } }, 401),
    );
    expect((await errorOf(synthesize(script, deps(fetch)))).message).toMatch(/refusée.*missing the permission text_to_speech/);
  });

  it('names the voice setting when the voice does not exist', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ detail: { status: 'voice_not_found', message: `A voice with voice_id ${VOICE_ID} was not found.` } }, 400),
    );
    expect((await errorOf(synthesize(script, deps(fetch)))).message).toMatch(
      /^voix ElevenLabs introuvable \(vérifier ELEVENLABS_VOICE_ID_FR\) : A voice with voice_id/,
    );
  });

  it('maps 402 and quota_exceeded to a quota message', async () => {
    const quota401 = vi.fn<typeof globalThis.fetch>(async () =>
      json({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota. You have 12 credits remaining.' } }, 401),
    );
    expect((await errorOf(synthesize(script, deps(quota401)))).message).toMatch(/quota ElevenLabs épuisé.*12 credits/);
    const payment = vi.fn<typeof globalThis.fetch>(async () => json({ detail: { status: 'payment_required' } }, 402));
    expect((await errorOf(synthesize(script, deps(payment)))).message).toMatch(/quota ElevenLabs épuisé/);
    const coded = vi.fn<typeof globalThis.fetch>(async () =>
      json({ detail: { type: 'invalid_request', code: 'quota_exceeded', message: 'Quota exceeded.' } }, 401),
    );
    expect((await errorOf(synthesize(script, deps(coded)))).message).toMatch(/quota ElevenLabs épuisé : .*Quota exceeded/);
  });

  it('shows the API detail of a 422 without the key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ detail: [{ loc: ['body', 'voice_settings', 'stability'], msg: `bad value near ${API_KEY}`, type: 'value_error' }] }, 422),
    );
    const err = await errorOf(synthesize(script, deps(fetch)));
    expect(err.message).toMatch(/refusés par ElevenLabs : stability : bad value near \*\*\*/);
    expect(err.message).not.toContain(API_KEY);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retries once after a 429', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ detail: { status: 'too_many_concurrent_requests', message: 'Too many' } }, 429))
      .mockResolvedValueOnce(json(okBody()));
    const { voiceover } = await synthesize(script, deps(fetch));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(voiceover.words).toHaveLength(6);
  });

  it('fails after two 5xx, waiting 2 s before the retry', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('Bad gateway', { status: 502 }));
    const { retryDelayMs: _, ...defaultDelay } = deps(fetch);
    const done = errorOf(synthesize(script, defaultDelay));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await done;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(err.message).toBe('ElevenLabs indisponible (HTTP 502) après une nouvelle tentative');
  });

  it('retries once when the body is cut off while being read', async () => {
    const cutOff = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      );
    const recovers = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(cutOff()).mockResolvedValueOnce(json(okBody()));
    const { voiceover } = await synthesize(script, deps(recovers));
    expect(recovers).toHaveBeenCalledTimes(2);
    expect(voiceover.words).toHaveLength(6);

    const fails = vi.fn<typeof globalThis.fetch>(async () => cutOff());
    const err = await errorOf(synthesize(script, deps(fails)));
    expect(fails).toHaveBeenCalledTimes(2);
    expect(err.message).toBe('ElevenLabs injoignable après une nouvelle tentative : terminated');
  });

  it('never puts the key in a network error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(`fetch failed with header xi-api-key=${API_KEY}`, { cause: new Error(`ECONNRESET ${API_KEY}`) });
    });
    const err = await errorOf(synthesize(script, deps(fetch)));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(err.message).toMatch(/^ElevenLabs injoignable après une nouvelle tentative/);
    expect(err.message).not.toContain(API_KEY);
  });

  it('sends no key header when the environment proxy provides the key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('stop');
    });
    await errorOf(synthesize(script, deps(fetch, { apiKey: undefined, retryDelayMs: 0 })));
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('xi-api-key');
    expect(headers['content-type']).toBe('application/json');
  });

  it('refuses an empty script or missing settings before any request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const empty = { ...script, segments: [{ kind: 'hook' as const, text: '  ', facts: [] }] };
    expect((await errorOf(synthesize(empty, deps(fetch)))).message).toMatch(/script vide/);
    expect((await errorOf(synthesize(script, deps(fetch, { voiceId: ' ' })))).message).toMatch(/voix ElevenLabs manquante/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('estimateVoiceover', () => {
  it('times the words evenly, without audio', () => {
    const v = estimateVoiceover(script);
    expect(v.audioPath).toBe('');
    expect(v.variant).toBe('social');
    expect(v.characters).toBe(TEXT.length);
    expect(v.words.map((w) => w.word)).toEqual(['Peugeot', '308', 'de', '2019,', `68${NBSP}000`, 'km.']);
    expect(v.words.map((w) => [w.start, w.end])).toEqual([
      [0, 0.4],
      [0.4, 0.8],
      [0.8, 1.2],
      [1.2, 1.6],
      [1.6, 2],
      [2, 2.4],
    ]);
    expect(v.durationSec).toBe(2.8);
  });

  it('follows the given pace', () => {
    const v = estimateVoiceover(script, { wordsPerSecond: 2 });
    expect(v.words.at(-1)?.end).toBe(3);
    expect(v.durationSec).toBe(3.4);
    expect(() => estimateVoiceover(script, { wordsPerSecond: 0 })).toThrow(/positif/);
  });
});
