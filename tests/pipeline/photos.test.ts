import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { largestVariant } from '@/lib/pipeline/photo-variants';
import { downloadPhotos, MAX_PHOTOS, selectPhotos } from '@/lib/pipeline/photos';
import { PHOTO_ROLES, type ClaudeClient, type LocalPhoto } from '@/lib/pipeline/types';
import { PHOTOS_PROMPT_VERSION, photosSystemPrompt } from '@/lib/prompts/photos.v2';
import { ACCEPT_IMAGE, DEFAULT_USER_AGENT } from '@/lib/probe/fetch';
import { parseSheet, type Sheet } from '@/lib/sheet';

const auto = parseSheet(JSON.parse(readFileSync(join(__dirname, '../fixtures/sheets/auto-308.json'), 'utf8')));
const immo = parseSheet({
  vertical: 'immo',
  platform: 'seloger',
  sourceUrl: 'https://www.seloger.com/annonce/achat/x/y/z/1',
  transaction: 'vente',
  propertyType: 'Appartement',
  currency: 'EUR',
  features: [],
  photos: [],
});

const withPhotos = (sheet: Sheet, urls: string[]): Sheet => ({ ...sheet, photos: urls.map((url) => ({ url })) });

const image = (width: number, height: number, kind: 'jpeg' | 'webp' = 'jpeg', background = '#c33') => {
  const img = sharp({ create: { width, height, channels: 3, background } });
  return (kind === 'jpeg' ? img.jpeg() : img.webp()).toBuffer();
};

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'photos-test-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const LBC = 'https://img.leboncoin.fr/api/v1/lbcpb1/images/aa/bb/cc/aabbcc0011223344556677889900aabbccddeeff.jpg';
const AS24 = 'https://prod.pictures.autoscout24.net/listing-images/0f2c1b9e-2d4b-4c1e-9a55-3a2f0c8d9e11_5b6c7d8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.jpg';
const SELOGER = 'https://mms.seloger.com/a/b/a/6/aba690f4-93db-44bb-8d4c-0fc0c5f3ca79.jpg?ci_seal=2a18f5c437177ab206bbe1254cb8d02279094778';
const PAP = 'https://cdn.pap.fr/photos/pap/af/2c/af2c19c7b92e0f3d327d0504129ff9e4/a-p2.webp';
const LACENTRALE = 'https://image-annonce.lacentrale.fr/1096x829/E119858725_STANDARD_0.jpg';

describe('largestVariant', () => {
  it('asks AutoScout24 for its 1920x1080 WebP, keeping the rest of the URL', () => {
    expect(largestVariant(`${AS24}/360x270.webp`)).toBe(`${AS24}/1920x1080.webp`);
    expect(largestVariant(`${AS24}/1280x960.jpg?v=2#x`)).toBe(`${AS24}/1920x1080.webp?v=2#x`);
    expect(largestVariant(AS24)).toBe(AS24); // no size suffix: nothing to change
    expect(largestVariant(`${AS24}/1920x1080.jpg`)).toBe(`${AS24}/1920x1080.webp`);
  });

  it('never trades an AutoScout24 size that does not fit inside 1920x1080 for a smaller one', () => {
    for (const size of ['2560x1440.webp', '1600x1200.webp', '1080x1920.jpg', '3840x2160.jpg']) {
      expect(largestVariant(`${AS24}/${size}`)).toBe(`${AS24}/${size}`);
    }
  });

  it('upgrades small Leboncoin rules to ad-large and leaves other parameters untouched', () => {
    expect(largestVariant(`${LBC}?rule=ad-large`)).toBe(`${LBC}?rule=ad-large`);
    expect(largestVariant(`${LBC}?rule=ad-image`)).toBe(`${LBC}?rule=ad-large`);
    expect(largestVariant(`${LBC}?a=b%20c&rule=ad-thumb&z=1`)).toBe(`${LBC}?a=b%20c&rule=ad-large&z=1`);
    // Other rules are kept (classified-1200x800-webp measured no bigger than ad-large), and so
    // is a missing rule, which may be the original.
    expect(largestVariant(`${LBC}?rule=classified-1200x800-webp`)).toBe(`${LBC}?rule=classified-1200x800-webp`);
    expect(largestVariant(LBC)).toBe(LBC);
  });

  it('never touches signed or unknown URLs', () => {
    expect(largestVariant(SELOGER)).toBe(SELOGER);
    expect(largestVariant(`${SELOGER}&w=800&h=600`)).toBe(`${SELOGER}&w=800&h=600`);
    expect(largestVariant(LACENTRALE)).toBe(LACENTRALE);
    expect(largestVariant(PAP)).toBe(PAP);
    expect(largestVariant(`http://prod.pictures.autoscout24.net/listing-images/x.jpg/360x270.webp`)).toBe(
      'http://prod.pictures.autoscout24.net/listing-images/x.jpg/360x270.webp',
    );
    expect(largestVariant('https://prod.pictures.autoscout24.net.evil.example/x.jpg/360x270.webp')).toBe(
      'https://prod.pictures.autoscout24.net.evil.example/x.jpg/360x270.webp',
    );
    expect(largestVariant('pas une url')).toBe('pas une url');
  });
});

type Route = () => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes[url];
    return route ? route() : new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const serve = (bytes: Buffer, type = 'image/jpeg') => () =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });

describe('downloadPhotos', () => {
  it('downloads the biggest variant, sniffs real images and falls back to the original URL', async () => {
    const lbc = await image(800, 600);
    const big = await image(1920, 1080, 'webp');
    const original = await image(1024, 768);
    const other = AS24.replace('0f2c', '1f2c');
    const { fetch, calls } = fakeFetch({
      [`${LBC}?rule=ad-large`]: serve(lbc),
      [`${AS24}/1920x1080.webp`]: serve(big, 'image/webp'),
      [PAP]: () => new Response('<!doctype html><title>Accueil</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
      [`${other}/360x270.webp`]: serve(original), // its 1920x1080 variant is a 404
    });
    const dir = join(tmp, 'download');
    const sheet = withPhotos(auto, [
      `${LBC}?rule=ad-image`,
      `${AS24}/360x270.webp`,
      PAP,
      `${other}/360x270.webp`,
      'http://img.leboncoin.fr/api/v1/lbcpb1/images/aa/bb/cc/x.jpg',
    ]);

    const { photos, failures } = await downloadPhotos(sheet, dir, { fetch });

    expect(photos.map((p) => p.index)).toEqual([0, 1, 3]);
    expect(photos[0]).toMatchObject({
      sourceUrl: `${LBC}?rule=ad-large`,
      path: join(dir, 'photo-0.jpg'),
      width: 800,
      height: 600,
      bytes: lbc.byteLength,
      format: 'jpeg',
    });
    expect(await readFile(join(dir, 'photo-0.jpg'))).toEqual(lbc);
    expect(photos[1]).toMatchObject({ path: join(dir, 'photo-1.webp'), width: 1920, height: 1080, format: 'webp' });
    expect(photos[2]).toMatchObject({ sourceUrl: `${other}/360x270.webp`, width: 1024, height: 768 });

    expect(failures).toEqual([
      { index: 2, url: PAP, reason: 'pas une image (text/html)' },
      { index: 4, url: 'http://img.leboncoin.fr/api/v1/lbcpb1/images/aa/bb/cc/x.jpg', reason: 'adresse refusée : https uniquement' },
    ]);
    expect(existsSync(join(dir, 'photo-2.webp'))).toBe(false);

    // The http photo is never requested; the 404 variant is tried once, then the original.
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${LBC}?rule=ad-large`, `${AS24}/1920x1080.webp`, PAP, `${other}/1920x1080.webp`, `${other}/360x270.webp`].sort(),
    );
    for (const { init } of calls) {
      expect(init.headers).toEqual({
        'user-agent': DEFAULT_USER_AGENT,
        accept: ACCEPT_IMAGE,
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      });
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('reports both attempts when the variant and the original fail', async () => {
    const { fetch } = fakeFetch({});
    const { photos, failures } = await downloadPhotos(withPhotos(auto, [`${AS24}/360x270.webp`]), join(tmp, 'both'), { fetch });
    expect(photos).toEqual([]);
    expect(failures[0]?.reason).toBe('grande taille : HTTP 404 ; adresse d’origine : HTTP 404');
  });

  it('follows https redirects only, and applies the EXIF orientation to the dimensions', async () => {
    const rotated = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#39c' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { fetch } = fakeFetch({
      [PAP]: () => new Response(null, { status: 302, headers: { location: 'https://cdn2.pap.fr/a.jpg' } }),
      'https://cdn2.pap.fr/a.jpg': serve(rotated),
      [LACENTRALE]: () => new Response(null, { status: 301, headers: { location: 'http://image-annonce.lacentrale.fr/a.jpg' } }),
    });
    const { photos, failures } = await downloadPhotos(withPhotos(auto, [PAP, LACENTRALE]), join(tmp, 'redirect'), { fetch });
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ index: 0, sourceUrl: PAP, width: 600, height: 800 });
    expect(failures).toEqual([{ index: 1, url: LACENTRALE, reason: 'adresse refusée : https uniquement' }]);
  });

  it('refuses local hosts, oversized files and slow hosts, and reads MAX_PHOTOS photos at most', async () => {
    const small = await image(64, 48);
    const { fetch, calls } = fakeFetch({
      [PAP]: () => new Response(new Uint8Array(small), { status: 200, headers: { 'content-length': String(16 * 1024 * 1024) } }),
      [LACENTRALE]: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    });
    const { failures } = await downloadPhotos(
      withPhotos(auto, [PAP, LACENTRALE, 'https://127.0.0.1/a.jpg', 'https://localhost/a.jpg', 'https://example.com:8443/a.jpg']),
      join(tmp, 'limits'),
      { fetch },
    );
    expect(failures.map((f) => f.reason)).toEqual([
      'image trop lourde (16 Mo, 15 Mo au plus)',
      'délai dépassé (15 s)',
      'adresse refusée : hôte local ou IP',
      'adresse refusée : hôte local ou IP',
      'adresse refusée : identifiants ou port dans l’URL',
    ]);
    expect(calls).toHaveLength(2);

    const local = await downloadPhotos(
      withPhotos(auto, ['https://localhost./a.jpg', 'https://photos.localhost/a.jpg', 'https://0x7f.1/a.jpg', 'https://[::1]/a.jpg']),
      join(tmp, 'local'),
      { fetch },
    );
    expect(local.failures.map((f) => f.reason)).toEqual(Array(4).fill('adresse refusée : hôte local ou IP'));
    expect(calls).toHaveLength(2);

    // A real pro listing had 42 photos: all of them are offered to the sort.
    expect(MAX_PHOTOS).toBeGreaterThanOrEqual(42);
    const many = fakeFetch({});
    const urls = Array.from({ length: MAX_PHOTOS + 5 }, (_, i) => `https://cdn.pap.fr/photos/pap/${i}-p2.webp`);
    const result = await downloadPhotos(withPhotos(auto, urls), join(tmp, 'many'), { fetch: many.fetch });
    expect(many.calls).toHaveLength(MAX_PHOTOS);
    expect(result.failures.map((f) => f.index)).toEqual(Array.from({ length: MAX_PHOTOS }, (_, i) => i));
  });

  it('starts no photo once the total download budget is spent, and keeps the ones downloaded', async () => {
    const good = await image(800, 600);
    const urls = Array.from({ length: 8 }, (_, i) => `https://cdn.pap.fr/photos/pap/${i}-p2.webp`);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { fetch, calls } = fakeFetch(
        Object.fromEntries(
          urls.map((url, i) => [
            url,
            () => {
              // The fourth photo is answered after 91 s: none is started after it.
              if (i === 3) vi.setSystemTime(Date.now() + 91_000);
              return serve(good)();
            },
          ]),
        ),
      );
      const { photos, failures } = await downloadPhotos(withPhotos(auto, urls), join(tmp, 'budget'), { fetch });
      expect(photos.map((p) => p.index)).toEqual([0, 1, 2, 3]);
      expect(failures).toEqual(
        urls.slice(4).map((url, i) => ({ index: i + 4, url, reason: 'pas commencée : délai total dépassé (90 s)' })),
      );
      expect(calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives short French reasons for undeclared oversized bodies, corrupt images, network errors and bad redirects', async () => {
    const good = await image(800, 600);
    const oversized = new Uint8Array(16 * 1024 * 1024);
    oversized.set(good.subarray(0, 16)); // starts like a JPEG, no content-length declared
    const corrupt = Buffer.concat([good.subarray(0, 4), Buffer.alloc(200, 7)]); // JPEG magic, garbage after
    const hosts = ['a', 'b', 'c', 'd'].map((h) => `https://cdn.pap.fr/photos/pap/${h}-p2.webp`);
    const { fetch } = fakeFetch({
      [hosts[0] as string]: () => new Response(oversized, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      [hosts[1] as string]: serve(corrupt),
      [hosts[2] as string]: () =>
        Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND cdn.pap.fr'), { code: 'ENOTFOUND' }) })),
      [hosts[3] as string]: () => new Response(null, { status: 302, headers: { location: 'https://[oups/a.jpg' } }),
    });
    const { photos, failures } = await downloadPhotos(withPhotos(auto, hosts), join(tmp, 'reasons'), { fetch });
    expect(photos).toEqual([]);
    expect(failures.map((f) => f.reason)).toEqual([
      'image trop lourde (plus de 15 Mo)',
      'image illisible',
      'échec réseau (ENOTFOUND)',
      'redirection vers une adresse invalide',
    ]);
    expect(existsSync(join(tmp, 'reasons', 'photo-1.jpg'))).toBe(false);
  });
});

type ParseParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  output_config: { effort: string; format: { type: string; schema: Record<string, unknown>; parse: (text: string) => unknown } };
  [key: string]: unknown;
};

type FakeAnswer = { json?: unknown; text?: string; stop_reason?: Anthropic.StopReason };

/** Stands in for messages.parse: like the SDK, runs the format's parse on the text block. */
function fakeClient(answers: FakeAnswer[]) {
  const calls: ParseParams[] = [];
  const parse = vi.fn(async (params: ParseParams) => {
    calls.push({ ...params, messages: [...params.messages] });
    const answer = answers.shift();
    if (!answer) throw new Error('appel inattendu');
    const text = answer.text ?? JSON.stringify(answer.json);
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text }],
      stop_reason: answer.stop_reason ?? 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      parsed_output: params.output_config.format.parse(text),
    };
  });
  return { client: { messages: { parse } } as unknown as ClaudeClient, calls };
}

/** Indexes with a gap, as after a failed download. */
const INDEXES = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10];
let photos: LocalPhoto[];

beforeAll(async () => {
  const dir = join(tmp, 'select');
  await mkdir(dir, { recursive: true });
  photos = await Promise.all(
    INDEXES.map(async (index) => {
      const bytes = await image(1600, 1200, 'jpeg', `#${(index * 23 + 16).toString(16).padStart(2, '0')}6699`);
      const path = join(dir, `photo-${index}.jpg`);
      await writeFile(path, bytes);
      return { index, sourceUrl: `${LBC}?rule=ad-large&n=${index}`, path, width: 1600, height: 1200, bytes: bytes.byteLength, format: 'jpeg' as const };
    }),
  );
});

const VALID = {
  selected: [
    { index: 5, role: 'intérieur' },
    { index: 0, role: 'trois-quarts avant' },
    { index: 2, role: 'arrière' },
    { index: 1, role: 'profil' },
    { index: 6, role: 'tableau de bord' },
    { index: 7, role: 'détail' },
    { index: 8, role: 'détail' },
    { index: 10, role: 'autre' },
    { index: 9, role: 'intérieur' },
  ],
  rejected: [{ index: 3, reason: 'doublon de la photo 0' }],
};

function imageBlocks(params: ParseParams): Anthropic.ImageBlockParam[] {
  const content = params.messages[0]?.content;
  return Array.isArray(content) ? content.filter((b): b is Anthropic.ImageBlockParam => b.type === 'image') : [];
}

describe('selectPhotos', () => {
  it('sends downscaled labelled photos and returns the kept ones in role order', async () => {
    const { client, calls } = fakeClient([{ json: VALID }]);
    const { selection, usage } = await selectPhotos(photos, auto, { client });

    expect(selection.selected.map((p) => [p.index, p.role])).toEqual([
      [0, 'trois-quarts avant'],
      [1, 'profil'],
      [2, 'arrière'],
      [5, 'intérieur'],
      [9, 'intérieur'],
      [6, 'tableau de bord'],
      [7, 'détail'],
      [8, 'détail'],
      [10, 'autre'],
    ]);
    expect(selection.selected[0]).toMatchObject({ path: photos[0]?.path, width: 1600, height: 1200, format: 'jpeg' });
    expect(selection.rejected).toEqual([{ index: 3, reason: 'doublon de la photo 0' }]);
    expect(usage).toEqual({ step: 'photos', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 100, costUsd: 0.003 });

    expect(calls).toHaveLength(1);
    const params = calls[0] as ParseParams;
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.max_tokens).toBe(16000);
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format.type).toBe('json_schema');
    // Roles are an enum the API enforces (the SDK's zod helper would only describe them).
    expect(params.output_config.format.schema).toEqual({
      type: 'object',
      properties: {
        selected: {
          type: 'array',
          items: {
            type: 'object',
            properties: { index: { type: 'integer' }, role: { type: 'string', enum: [...PHOTO_ROLES.auto] } },
            required: ['index', 'role'],
            additionalProperties: false,
          },
        },
        rejected: {
          type: 'array',
          items: {
            type: 'object',
            properties: { index: { type: 'integer' }, reason: { type: 'string' } },
            required: ['index', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['selected', 'rejected'],
      additionalProperties: false,
    });
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('thinking');
    expect(JSON.stringify(params)).not.toContain('budget_tokens');
    expect(params.system).toContain('entre 8 et 10 photos');
    expect(params.system).toContain('trois-quarts avant → profil → arrière');
    expect(params.messages).toHaveLength(1);

    const content = params.messages[0]?.content as Anthropic.ContentBlockParam[];
    const labels = content.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map((b) => b.text);
    expect(labels[0]).toContain('« Peugeot 308 1.2 PureTech 130ch S&S BVM6 Allure »');
    expect(labels).toEqual(expect.arrayContaining(INDEXES.map((i) => `Photo ${i}`)));
    const blocks = imageBlocks(params);
    expect(blocks).toHaveLength(INDEXES.length);
    // Each image follows its label.
    INDEXES.forEach((index, n) => {
      const at = content.indexOf(blocks[n] as Anthropic.ContentBlockParam);
      expect(content[at - 1]).toEqual({ type: 'text', text: `Photo ${index}` });
    });
    const first = blocks[0]?.source;
    expect(first).toMatchObject({ type: 'base64', media_type: 'image/jpeg' });
    const meta = await sharp(Buffer.from((first as Anthropic.Base64ImageSource).data, 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 512, 384]);
    expect(PHOTOS_PROMPT_VERSION).toBe('photos.v2');
  });

  it('goes through the real SDK: the body sent carries the JSON schema and no sampling settings', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new Anthropic({
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        const message = {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: JSON.stringify(VALID) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 100 },
        };
        return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    const { selection } = await selectPhotos(photos, auto, { client });
    expect(selection.selected).toHaveLength(9);
    const body = bodies[0] as ParseParams;
    expect(body.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(body.output_config.format).not.toHaveProperty('parse');
    expect(body.output_config.format.schema).toMatchObject({
      properties: { selected: { items: { properties: { role: { enum: [...PHOTO_ROLES.auto] } } } } },
    });
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(imageBlocks(body)).toHaveLength(INDEXES.length);
  });

  it('retries once with the problems appended after an invalid answer (duplicate index)', async () => {
    const duplicate = { ...VALID, selected: [...VALID.selected.slice(0, 8), { index: 0, role: 'autre' }] };
    const { client, calls } = fakeClient([{ json: duplicate }, { json: VALID }]);
    const { selection, usage } = await selectPhotos(photos, auto, { client });

    expect(selection.selected).toHaveLength(9);
    expect(usage.inputTokens).toBe(2000);
    expect(usage.outputTokens).toBe(200);
    expect(calls).toHaveLength(2);
    const retry = calls[1]?.messages ?? [];
    expect(retry).toHaveLength(3);
    expect(retry[0]).toBe(calls[0]?.messages[0]);
    expect(retry[1]).toEqual({ role: 'assistant', content: JSON.stringify(duplicate) });
    expect(retry[2]?.role).toBe('user'); // no prefill: the conversation ends on the user
    expect(retry[2]?.content).toContain('la photo 0 apparaît plusieurs fois');
    expect(retry[2]?.content).toContain('photos ni gardées ni écartées : 9');
  });

  it('retries once when the answer breaks the schema (unknown role)', async () => {
    const badRole = { ...VALID, selected: [{ index: 0, role: 'moteur' }, ...VALID.selected.slice(1)] };
    const { client, calls } = fakeClient([{ json: badRole }, { json: VALID }]);
    await selectPhotos(photos, auto, { client });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages[2]?.content).toContain('selected.0.role');
  });

  it('throws a French error when the retry is invalid too', async () => {
    const unknown = { ...VALID, rejected: [{ index: 3, reason: 'floue' }, { index: 42, reason: 'floue' }] };
    const duplicate = { ...VALID, rejected: [{ index: 3, reason: 'floue' }, { index: 5, reason: 'floue' }] };
    const { client, calls } = fakeClient([{ json: duplicate }, { json: unknown }]);
    await expect(selectPhotos(photos, auto, { client })).rejects.toThrow(
      /Tri des photos invalide après une relance : la photo 42 n’existe pas/,
    );
    expect(calls).toHaveLength(2);
  });

  it('stops on a refusal or a truncated answer, without retrying', async () => {
    const refusal = fakeClient([{ text: 'Je ne peux pas.', stop_reason: 'refusal' }]);
    await expect(selectPhotos(photos, auto, { client: refusal.client })).rejects.toThrow(/refusé/);
    expect(refusal.calls).toHaveLength(1);

    const truncated = fakeClient([{ text: '{"selected":[', stop_reason: 'max_tokens' }]);
    await expect(selectPhotos(photos, auto, { client: truncated.client })).rejects.toThrow(/max_tokens/);
    expect(truncated.calls).toHaveLength(1);
  });

  it('asks once more when fewer photos than the minimum are kept, then trusts the answer', async () => {
    const few = {
      selected: VALID.selected.slice(0, 7),
      rejected: [3, 9, 10].map((index) => ({ index, reason: 'trop sombre' })),
    };
    const { client, calls } = fakeClient([{ json: few }, { json: few }]);
    const { selection } = await selectPhotos(photos, auto, { client });
    expect(selection.selected).toHaveLength(7);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages[2]?.content).toContain('garde-en au moins 8');
  });

  it('throws when no photo is usable, or none was downloaded', async () => {
    const none = { selected: [], rejected: INDEXES.map((index) => ({ index, reason: 'logo du garage' })) };
    const { client } = fakeClient([{ json: none }, { json: none }]);
    await expect(selectPhotos(photos, auto, { client })).rejects.toThrow(/Aucune photo utilisable/);

    const idle = fakeClient([]);
    await expect(selectPhotos([], auto, { client: idle.client })).rejects.toThrow(/Aucune photo/);
    expect(idle.calls).toHaveLength(0);
  });

  it('rejects unreadable files without sending them, and uses the immo roles', async () => {
    const broken = join(tmp, 'select', 'photo-11.jpg');
    await writeFile(broken, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const three = [...photos.slice(0, 3), { ...(photos[0] as LocalPhoto), index: 11, path: broken }];
    const answer = {
      selected: [
        { index: 2, role: 'plan' },
        { index: 0, role: 'façade ou vue' },
        { index: 1, role: 'cuisine' },
      ],
      rejected: [],
    };
    const { client, calls } = fakeClient([{ json: answer }]);
    const { selection } = await selectPhotos(three, immo, { client });

    expect(calls).toHaveLength(1); // 3 photos: fewer than the immo minimum, all kept
    expect(imageBlocks(calls[0] as ParseParams)).toHaveLength(3);
    expect(calls[0]?.system).toContain('entre 10 et 14 photos');
    expect(calls[0]?.output_config.format.schema).toMatchObject({
      properties: { selected: { items: { properties: { role: { enum: [...PHOTO_ROLES.immo] } } } } },
    });
    expect(selection.selected.map((p) => p.role)).toEqual(['façade ou vue', 'cuisine', 'plan']);
    expect(selection.rejected).toEqual([{ index: 11, reason: 'image illisible' }]);
  });
});

describe('photosSystemPrompt', () => {
  it('asks for the same role order as the one the code applies', () => {
    for (const vertical of ['auto', 'immo'] as const) {
      const prompt = photosSystemPrompt(vertical);
      expect(prompt).toContain(`dans cet ordre de rôles : ${PHOTO_ROLES[vertical].join(' → ')}.`);
      // No role hint may place a photo elsewhere (e.g. "plan en dernier" while "autre" follows it).
      expect(prompt).not.toMatch(/en dernier|en premier/);
    }
  });

  it('rejects mostly-logo visuals and close-ups of connected phone screens, not watermarks, the dealer sign or a dashboard overview', () => {
    for (const vertical of ['auto', 'immo'] as const) {
      const prompt = photosSystemPrompt(vertical);
      expect(prompt).toContain('les visuels faits surtout d’un logo, d’une bannière, d’une publicité ou de texte');
      expect(prompt).toContain('les gros plans d’un écran qui affiche un téléphone connecté (applications, notifications, messages)');
      expect(prompt).toContain('Ne sont pas des raisons d’écarter une photo :\n- un filigrane ou un petit logo dans un coin');
      expect(prompt).toContain('« leboncoin »');
      // Both formats use the same photos, and the listing one shows neither price nor phone.
      expect(prompt).toContain('À cadrage égal, préfère une photo où aucun numéro de téléphone ni aucun prix n’est lisible');
      // v1 rejected any "logo" or "bannière de garage", which covered a car shot in front of the dealer's sign.
      expect(prompt).not.toContain('bannières de garage');
    }
    expect(photosSystemPrompt('auto')).toContain('l’enseigne ou le logo du garage à l’arrière-plan d’une vraie photo de la voiture');
    // A wide dashboard shot shows the centre screen, often in phone mode: only close-ups of it are rejected.
    expect(photosSystemPrompt('auto')).toContain('vu en petit dans une vue d’ensemble du tableau de bord : c’est une photo du tableau de bord');
    expect(photosSystemPrompt('immo')).not.toContain('garage à l’arrière-plan');
    expect(photosSystemPrompt('auto')).toContain('n’est lisible (enseigne, affichette, pare-brise)');
    expect(photosSystemPrompt('immo')).toContain('n’est lisible (panneau « à vendre », affichette, vitrine)');
  });
});
