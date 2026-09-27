import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchPlatform } from '@/lib/probe/platforms';
import { DEFAULT_CONFIG, probeOne, resolveTargets } from '@/lib/probe/run';

describe('matchPlatform', () => {
  it.each([
    ['https://www.leboncoin.fr/ad/voitures/3209507340', 'leboncoin-auto'],
    ['https://www.leboncoin.fr/ad/ventes_immobilieres/2999999999', 'leboncoin-immo'],
    ['https://www.autoscout24.fr/offres/renault-clio-tce-90-essence-blanc-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'autoscout24-fr'],
    ['https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26ZCAGW19827', 'seloger'],
    ['https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html', 'lacentrale'],
    ['https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049', 'pap'],
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
    'https://169.254.169.254/ad/voitures/1',
  ])('refuses %s (search page, wrong scheme or foreign host)', (url) => {
    expect(matchPlatform(new URL(url))).toBeUndefined();
  });
});

describe('resolveTargets', () => {
  it('uses the seed listings when no URL is given', () => {
    const { targets, rejected } = resolveTargets([], []);
    expect(targets).toHaveLength(6);
    expect(rejected).toEqual([]);
  });

  it('lets a URL override the seed of its platform and filters platforms', () => {
    const fresh = 'https://www.leboncoin.fr/ad/ventes_immobilieres/2999999999';
    const { targets } = resolveTargets([fresh], ['leboncoin-immo']);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.url?.href).toBe(fresh);
  });

  it('rejects search pages, foreign hosts and a second listing on the same platform', () => {
    const { targets, rejected } = resolveTargets(
      [
        'https://www.leboncoin.fr/ad/voitures/1',
        'https://www.leboncoin.fr/ad/voitures/2',
        'https://www.leboncoin.fr/recherche?category=2',
        'https://example.com/',
        'not a url',
      ],
      [],
    );
    expect(targets.find((t) => t.platform.id === 'leboncoin-auto')?.url?.href).toBe('https://www.leboncoin.fr/ad/voitures/1');
    expect(rejected.map((r) => r.input)).toEqual([
      'https://www.leboncoin.fr/ad/voitures/2',
      'https://www.leboncoin.fr/recherche?category=2',
      'https://example.com/',
      'not a url',
    ]);
  });

  it('caps the number of URLs per call', () => {
    const inputs = Array.from({ length: 8 }, (_, i) => `https://www.pap.fr/annonces/maison-lyon-r${i}`);
    const { rejected } = resolveTargets(inputs, []);
    expect(rejected.filter((r) => r.reason.includes('au plus'))).toHaveLength(2);
  });
});

describe('probeOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const target = () => {
    const { targets } = resolveTargets([], ['leboncoin-auto']);
    const t = targets[0];
    if (!t) throw new Error('no target');
    return t;
  };

  it('does not follow a redirect that leaves the listing (expired ad to search page)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 301, headers: { location: '/voitures/offres' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeOne(target(), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe('expirée');
    expect(r.reasons[0]).toContain('/voitures/offres');
  });

  it('follows a redirect that stays on a listing of the same platform', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://leboncoin.fr/ad/voitures/3209507340' } }))
      .mockResolvedValueOnce(new Response('<html><title>x</title><body>Not found</body></html>', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeOne(target(), DEFAULT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.redirects).toEqual(['https://leboncoin.fr/ad/voitures/3209507340']);
    expect(r.verdict).toBe('expirée');
  });

  it('sends a browser User-Agent and French Accept-Language, and keeps cookie names only', async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      expect(h.get('user-agent')).toMatch(/Chrome\/\d+/);
      expect(h.get('accept-language')).toMatch(/^fr-FR/);
      const res = new Response('<html><head><title>t</title></head><body>' + 'x'.repeat(300) + '</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      res.headers.append('set-cookie', 'datadome=SECRET_VALUE; Path=/');
      return res;
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeOne(target(), DEFAULT_CONFIG);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(r)).not.toContain('x'.repeat(300));
  });

  it('truncates very large bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a'.repeat(5000), { status: 200 })));
    const r = await probeOne(target(), { ...DEFAULT_CONFIG, maxBytes: 1000 });
    expect(r.bytes).toBe(1000);
    expect(r.warnings.some((w) => w.includes('tronquée'))).toBe(true);
  });

  it('reports network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const r = await probeOne(target(), DEFAULT_CONFIG);
    expect(r.verdict).toBe('erreur');
    expect(r.reasons[0]).toContain('fetch failed');
  });

  it('marks a platform without a seed URL as not tested', async () => {
    const { targets } = resolveTargets([], ['leboncoin-immo']);
    const t = targets[0];
    if (!t) throw new Error('no target');
    if (t.url) return; // a seed URL was configured
    const r = await probeOne(t, DEFAULT_CONFIG);
    expect(r.verdict).toBe('non testé');
  });
});
