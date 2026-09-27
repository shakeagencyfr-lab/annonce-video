import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNDICI_ADDED_HEADERS } from '@/lib/probe/fetch';
import { PLATFORMS, matchPlatform } from '@/lib/probe/platforms';
import { DEFAULT_CONFIG, probeAll, probeTarget, resolveTargets, type ProbeTarget } from '@/lib/probe/run';

describe('matchPlatform', () => {
  it.each([
    ['https://www.leboncoin.fr/ad/voitures/3209507340', 'leboncoin-auto'],
    ['https://www.leboncoin.fr/ad/ventes_immobilieres/2999999999', 'leboncoin-immo'],
    ['https://www.autoscout24.fr/offres/renault-clio-tce-90-essence-blanc-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'autoscout24-fr'],
    ['https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26ZCAGW19827', 'seloger'],
    ['https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html', 'lacentrale'],
    ['https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049', 'pap'],
    ['https://WWW.LEBONCOIN.FR/ad/voitures/3209507340', 'leboncoin-auto'],
  ])('accepts the listing %s', (url, id) => {
    expect(matchPlatform(new URL(url))?.id).toBe(id);
  });

  it.each([
    'https://www.leboncoin.fr/recherche?category=2',
    'https://www.leboncoin.fr/voitures/offres',
    'https://www.leboncoin.fr/ad/voitures/',
    'https://www.autoscout24.fr/lst/renault/clio',
    'https://www.seloger.com/list.htm?projects=2',
    'https://www.lacentrale.fr/listing?makesModelsCommercialNames=RENAULT',
    'https://www.pap.fr/annonce/vente-appartement-marseille-13-g12024',
    'http://www.leboncoin.fr/ad/voitures/3209507340',
    'https://www.leboncoin.fr:8443/ad/voitures/3209507340',
    'https://user:pw@www.leboncoin.fr/ad/voitures/3209507340',
    'https://leboncoin.fr.evil.example/ad/voitures/3209507340',
    'https://www.leboncoin.fr./ad/voitures/3209507340',
    'https://169.254.169.254/ad/voitures/1',
    'https://www.seloger.com/annonces/achat/appartement/paris',
    'https://www.seloger.com/annonces/locations/appartement/lyon/',
    'https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille',
    'https://www.seloger.com/annonces/achat/a/b/c/d/e/f/g/h',
    'https://www.autoscout24.fr/offres/renault',
    'https://www.autoscout24.fr/offres/renault-clio-essence',
  ])('refuses %s (search page, wrong scheme or foreign host)', (url) => {
    expect(matchPlatform(new URL(url))).toBeUndefined();
  });

  it('accepts every seed URL, and each seed belongs to its own platform', () => {
    for (const p of PLATFORMS) {
      for (const seed of p.seedUrls) expect(matchPlatform(new URL(seed))?.id).toBe(p.id);
    }
  });
});

describe('resolveTargets', () => {
  it('uses the seed listings when no URL is given', () => {
    const { targets, rejected } = resolveTargets([], []);
    expect(targets).toHaveLength(6);
    expect(targets.every((t) => t.urls.length > 0 && t.urls.length <= 3)).toBe(true);
    expect(rejected).toEqual([]);
  });

  it('lets URLs replace the seeds of their platform and filters platforms', () => {
    const fresh = 'https://www.leboncoin.fr/ad/ventes_immobilieres/2999999999';
    const { targets } = resolveTargets([fresh], ['leboncoin-immo']);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.urls.map((u) => u.href)).toEqual([fresh]);
  });

  it('rejects search pages, foreign hosts, unknown platforms and a fourth listing on one platform', () => {
    const { targets, rejected } = resolveTargets(
      [
        'https://www.leboncoin.fr/ad/voitures/1',
        'https://www.leboncoin.fr/ad/voitures/2',
        'https://www.leboncoin.fr/ad/voitures/3',
        'https://www.leboncoin.fr/ad/voitures/4',
        'https://www.leboncoin.fr/ad/voitures/1#dup',
        'https://www.leboncoin.fr/recherche?category=2',
        'https://example.com/',
        'not a url',
      ],
      ['leboncoin-auto', 'nope'],
    );
    expect(targets[0]?.urls.map((u) => u.pathname)).toEqual(['/ad/voitures/1', '/ad/voitures/2', '/ad/voitures/3']);
    expect(rejected.map((r) => r.input)).toEqual([
      'https://www.leboncoin.fr/ad/voitures/4',
      'https://www.leboncoin.fr/recherche?category=2',
      'https://example.com/',
      'not a url',
      'nope',
    ]);
  });

  it('strips the query string and fragment of the URLs passed in', () => {
    const { targets } = resolveTargets(['https://www.leboncoin.fr/ad/voitures/1?utm_source=x&cb=2#photos'], ['leboncoin-auto']);
    expect(targets[0]?.urls[0]?.href).toBe('https://www.leboncoin.fr/ad/voitures/1');
  });

  it('caps the number of URLs per call', () => {
    const inputs = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`);
    const { rejected } = resolveTargets(inputs, []);
    expect(rejected.filter((r) => r.reason.includes('URLs par appel'))).toHaveLength(2);
  });
});

describe('probeTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lbc = (...ids: number[]): ProbeTarget => {
    const platform = PLATFORMS.find((p) => p.id === 'leboncoin-auto');
    if (!platform) throw new Error('missing platform');
    return { platform, urls: ids.map((id) => new URL(`https://www.leboncoin.fr/ad/voitures/${id}`)) };
  };
  const page = (status: number, body = '') => new Response(body, { status, headers: { 'content-type': 'text/html' } });

  it('does not follow a redirect that leaves the listing', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 301, headers: { location: '/voitures/offres' } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe('expirée');
    expect(r.reasons[0]).toContain('/voitures/offres');
  });

  it('calls out a redirect to the homepage as possibly a silent block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://www.leboncoin.fr/' } })));
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.reasons[0]).toContain('blocage discret');
  });

  it('follows a redirect that stays on a listing of the same platform', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://leboncoin.fr/ad/voitures/1' } }))
      .mockResolvedValueOnce(page(403, 'blocked'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.redirects).toEqual(['https://leboncoin.fr/ad/voitures/1']);
    expect(r.verdict).toBe('bloqué');
  });

  it('reports a redirect carrying a DataDome block header as blocked, not expired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://www.leboncoin.fr/', 'x-dd-b': '1', 'x-datadome': 'protected' } })),
    );
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.verdict).toBe('bloqué');
    expect(r.status).toBe(302);
    expect(r.headers['x-dd-b']).toBe('1');
  });

  it('keeps an off-listing redirect with only DataDome traces as expired, with a warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 301, headers: { location: '/voitures/offres', 'x-datadome': 'protected' } })),
    );
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.verdict).toBe('expirée');
    expect(r.warnings.some((w: string) => w.includes('DataDome'))).toBe(true);
  });

  it('reports a cookie-setting redirect loop as a probable anti-bot check', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      const res = new Response(null, { status: 302, headers: { location: url.href } });
      res.headers.append('set-cookie', 'check=VALUE; Path=/');
      return res;
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe('bloqué');
    expect(r.cookieNames).toEqual(['check']);
    expect(JSON.stringify(r)).not.toContain('VALUE');
  });

  it('keeps status and headers when the body stalls after them', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException('timed out', 'TimeoutError');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stalled, { status: 403, headers: { 'x-datadome': 'protected' } })));
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.status).toBe(403);
    expect(r.verdict).toBe('bloqué');
    expect(r.reasons.some((x: string) => x.includes('délai dépassé'))).toBe(true);
  });

  it('never returns the DataDome client id header value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403, headers: { 'x-datadome-cid': 'DD_CLIENT_TOKEN_abc' } })));
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.headers['x-datadome-cid']).toBe('présent');
    expect(JSON.stringify(r)).not.toContain('DD_CLIENT_TOKEN_abc');
  });

  it('reports "bloqué" when every fresh listing is sent to the homepage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: '/' } })));
    const r = await probeTarget(lbc(1, 2, 3), DEFAULT_CONFIG);
    expect(r.attempts).toHaveLength(3);
    expect(r.verdict).toBe('bloqué');
    expect(r.reasons.at(-1)).toContain('blocage discret probable');
  });

  it('stops after the redirect cap even when every hop is a listing', async () => {
    let n = 1;
    const fetchMock = vi.fn(async () => new Response(null, { status: 301, headers: { location: `/ad/voitures/${++n}` } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_CONFIG.maxRedirects + 1);
    expect(r.verdict).toBe('erreur');
    expect(r.reasons[0]).toContain(`plus de ${DEFAULT_CONFIG.maxRedirects} redirections`);
  });

  it('tries the next listing only after an expired one', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page(410)).mockResolvedValueOnce(page(403, 'x')).mockResolvedValueOnce(page(200));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeTarget(lbc(1, 2, 3), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.attempts.map((a) => [a.status, a.verdict])).toEqual([
      [410, 'expirée'],
      [403, 'bloqué'],
    ]);
    expect(r.url).toBe('https://www.leboncoin.fr/ad/voitures/2');
  });

  it('sends a browser User-Agent and French Accept-Language, no cache mode, and keeps no body or cookie value', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.cache).toBeUndefined();
      expect(init?.redirect).toBe('manual');
      const h = new Headers(init?.headers);
      expect(h.get('user-agent')).toMatch(/Chrome\/\d+/);
      expect(h.get('accept-language')).toMatch(/^fr-FR/);
      const res = page(200, `<html><head><title>t</title></head><body>${'x'.repeat(6000)}</body></html>`);
      res.headers.append('set-cookie', 'datadome=SECRET_VALUE; Path=/');
      return res;
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.status).toBe(200);
    expect(r.cookieNames).toEqual(['datadome']);
    expect(JSON.stringify(r)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(r)).not.toContain('x'.repeat(100));
  });

  it('truncates bodies over the cap, and only those', async () => {
    const cap = { ...DEFAULT_CONFIG, maxBytes: 1000 };
    vi.stubGlobal('fetch', vi.fn(async () => page(200, 'a'.repeat(5000))));
    const over = await probeTarget(lbc(1), cap);
    expect(over.bytes).toBe(1000);
    expect(over.warnings.some((w: string) => w.includes('tronquée'))).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => page(200, 'a'.repeat(1000))));
    const exact = await probeTarget(lbc(1), cap);
    expect(exact.bytes).toBe(1000);
    expect(exact.warnings.some((w: string) => w.includes('tronquée'))).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => page(200, 'a'.repeat(1001))));
    expect((await probeTarget(lbc(1), cap)).warnings.some((w: string) => w.includes('tronquée'))).toBe(true);
  });

  it('reports network errors and timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await probeTarget(lbc(1), DEFAULT_CONFIG)).reasons[0]).toContain('fetch failed');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    const r = await probeTarget(lbc(1), DEFAULT_CONFIG);
    expect(r.verdict).toBe('erreur');
    expect(r.reasons[0]).toContain('délai dépassé');
  });

  it('stops before the time budget runs out', async () => {
    const fetchMock = vi.fn(async () => page(403, 'x'));
    vi.stubGlobal('fetch', fetchMock);
    const results = await probeAll([lbc(1), lbc(2)], DEFAULT_CONFIG, DEFAULT_CONFIG.timeoutMs - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.map((r) => r.verdict)).toEqual(['non testé', 'non testé']);
    expect(results[0]?.reasons[0]).toContain('temps imparti');
  });
});

describe('UNDICI_ADDED_HEADERS', () => {
  it('names headers that Node fetch really adds', async () => {
    const server = http.createServer((req, res) => res.end(JSON.stringify(req.rawHeaders.map((h) => h.toLowerCase()))));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', headers: { 'user-agent': 'UA' } });
      const sent = (await res.json()) as string[];
      for (const header of UNDICI_ADDED_HEADERS) {
        expect(sent).toContain(header.split(':', 1)[0]);
      }
    } finally {
      server.close();
    }
  });
});
