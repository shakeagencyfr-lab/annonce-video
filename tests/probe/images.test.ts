import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_GROUPS,
  imageGroupFor,
  imagesToMarkdown,
  probeImage,
  probeImages,
  resolveImageTargets,
  sniffImage,
} from '@/lib/probe/images';
import { DEFAULT_CONFIG } from '@/lib/probe/run';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, ...new Array(2000).fill(1)]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 '), ...new Array(100).fill(0)]);

const image = (bytes: Uint8Array, type = 'image/jpeg') =>
  new Response(new Blob([new Uint8Array(bytes)]), { status: 200, headers: { 'content-type': type, server: 'nginx' } });
const html = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

const lbcPhoto = 'https://img.leboncoin.fr/api/v1/lbcpb1/images/aa/bb/cc/aabbcc0011223344556677889900aabbccddeeff.jpg?rule=ad-large';

describe('sniffImage', () => {
  it('recognises formats by their first bytes', () => {
    expect(sniffImage(JPEG)).toBe('jpeg');
    expect(sniffImage(WEBP)).toBe('webp');
    expect(sniffImage(new Uint8Array([0x89, ...Buffer.from('PNG'), 0, 0]))).toBe('png');
    expect(sniffImage(new Uint8Array([0, 0, 0, 0x1c, ...Buffer.from('ftypavif')]))).toBe('avif');
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
    expect(sniffImage(undefined)).toBeNull();
  });
});

describe('imageGroupFor and resolveImageTargets', () => {
  it('accepts only the photo hosts of the platforms, over https', () => {
    expect(imageGroupFor(new URL(lbcPhoto))?.id).toBe('leboncoin');
    expect(imageGroupFor(new URL('https://pictures.lacentrale.fr/classifieds/E1_STANDARD_0.jpg'))?.id).toBe('lacentrale');
    expect(imageGroupFor(new URL('https://www.leboncoin.fr/ad/voitures/1'))).toBeUndefined();
    expect(imageGroupFor(new URL('http://img.leboncoin.fr/x.jpg'))).toBeUndefined();
    expect(imageGroupFor(new URL('https://img.leboncoin.fr.evil.example/x.jpg'))).toBeUndefined();
  });

  it('lets given images replace the seeds of their platform, and rejects other hosts', () => {
    const { targets, rejected } = resolveImageTargets([lbcPhoto, 'https://example.com/a.jpg'], ['leboncoin']);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.candidates).toEqual([{ url: new URL(lbcPhoto), source: 'fournie' }]);
    expect(rejected.map((r) => r.input)).toEqual(['https://example.com/a.jpg']);
  });

  it('gives every group a well-formed control URL on its own hosts', () => {
    for (const g of IMAGE_GROUPS) {
      expect(imageGroupFor(new URL(g.missingImage))?.id).toBe(g.id);
      for (const seed of g.seedImages) expect(imageGroupFor(new URL(seed))?.id).toBe(g.id);
    }
  });
});

describe('probeImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a real image as accessible and asks for images, not HTML', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('accept')).toMatch(/^image\//);
      return image(JPEG);
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG);
    expect(p.verdict).toBe('accessible');
    expect(p.format).toBe('jpeg');
    expect(p.bytes).toBe(JPEG.length);
  });

  it('does not trust the Content-Type: an HTML page served as image/jpeg is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => image(Buffer.from('<html>oops</html>'), 'image/jpeg')));
    expect((await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG)).verdict).toBe('erreur');
  });

  it('reports a DataDome or Cloudflare page as blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html(403, "<html><title>leboncoin.fr</title><script>var dd={'rt':'c','t':'fe','host':'geo.captcha-delivery.com'}</script></html>")),
    );
    const p = await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG);
    expect(p.verdict).toBe('bloqué');
    expect(p.reasons[0]).toContain('DataDome');
  });

  it('tells a missing object (404, or storage XML error) from a block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
    expect((await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG)).verdict).toBe('introuvable');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', {
          status: 403,
          headers: { 'content-type': 'application/xml' },
        }),
      ),
    );
    const p = await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG);
    expect(p.verdict).toBe('introuvable');
    expect(p.reasons[0]).toContain('AccessDenied');

    vi.stubGlobal('fetch', vi.fn(async () => html(403, 'Forbidden')));
    expect((await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG)).verdict).toBe('bloqué');
  });

  it('does not follow a redirect to another host', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://www.leboncoin.fr/' } }));
    vi.stubGlobal('fetch', fetchMock);
    const p = await probeImage(new URL(lbcPhoto), 'recherche', DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p.verdict).toBe('erreur');
    expect(p.reasons.at(-1)).toContain('non suivie');
  });
});

describe('probeImages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes the AutoScout24 photo from a readable listing, then checks the control', async () => {
    const photo =
      'https://prod.pictures.autoscout24.net/listing-images/fb8ad31a-0ba8-40fd-ad7d-ac421aca199c_11111111-2222-3333-4444-555555555555.jpg/1280x960.webp';
    const listing = `<html><script id="__NEXT_DATA__">{"props":{"pageProps":{"listingDetails":{"images":["${photo.replace(/\//g, '\\/')}"]}}}}</script></html>`;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        calls.push(url.href);
        if (url.hostname === 'www.autoscout24.fr') return html(200, listing);
        if (url.href === photo) return image(WEBP, 'image/webp');
        return new Response('', { status: 404 });
      }),
    );
    const { targets } = resolveImageTargets([], ['autoscout24']);
    const [r] = await probeImages(targets, DEFAULT_CONFIG, 100_000);
    expect(r?.verdict).toBe('accessible');
    expect(r?.image?.source).toBe('annonce');
    expect(r?.image?.format).toBe('webp');
    expect(r?.control?.status).toBe(404);
    expect(calls).toHaveLength(3); // one listing, one photo, one control
  });

  it('stops trying candidates once one is found, and reports a blocked control', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        seen.push(url.href);
        return html(403, '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>', {
          'cf-mitigated': 'challenge',
        });
      }),
    );
    const { targets } = resolveImageTargets(
      ['https://cdn.pap.fr/photos/pap/01/23/0123456789abcdef0123456789abcdef/0-p2.webp', 'https://cdn.pap.fr/photos/pap/01/23/fedcba9876543210fedcba9876543210/0-p2.webp'],
      ['pap'],
    );
    const [r] = await probeImages(targets, DEFAULT_CONFIG, 100_000);
    expect(r?.verdict).toBe('bloqué');
    expect(r?.attempts).toHaveLength(1);
    expect(seen).toHaveLength(2); // first candidate, then the control
    const md = imagesToMarkdown([r!], { probedAt: 't', region: 'cdg1', node: 'v22', warnings: [], rejected: [] });
    expect(md).toContain('| PAP | cdn.pap.fr | fournie | 403 |');
    expect(md).toContain('**bloqué**');
  });

  it('asks for a fresh image when every known one is gone but the host answers normally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404, headers: { server: 'nginx' } })));
    const { targets } = resolveImageTargets(
      ['https://mms.seloger.com/a/b/a/6/aba690f4-93db-44bb-8d4c-0fc0c5f3ca79.jpg'],
      ['seloger'],
    );
    const [r] = await probeImages(targets, DEFAULT_CONFIG, 100_000);
    expect(r?.verdict).toBe('introuvable');
    expect(r?.reasons.join(' ')).toContain('sans protection anti-robot');
  });
});
