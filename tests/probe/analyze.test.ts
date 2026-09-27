import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, normalizeBody, type RawResponse } from '@/lib/probe/analyze';
import { getPlatform, laCentraleReference, type PlatformId } from '@/lib/probe/platforms';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/probe', name), 'utf8');

function raw(body: string, overrides: Partial<RawResponse> = {}): RawResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    cookieNames: [],
    body,
    bytes: Buffer.byteLength(body),
    truncated: false,
    ...overrides,
  };
}

const SEED: Record<PlatformId, string> = {
  'leboncoin-auto': 'https://www.leboncoin.fr/ad/voitures/3209507340',
  'leboncoin-immo': 'https://www.leboncoin.fr/ad/ventes_immobilieres/3259370552',
  'autoscout24-fr':
    'https://www.autoscout24.fr/offres/peugeot-3008-hybrid-145-e-dcs6-gt-electrique-essence-blanc-fb8ad31a-0ba8-40fd-ad7d-ac421aca199c',
  seloger:
    'https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26ZCAGW19827',
  lacentrale: 'https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html',
  pap: 'https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049',
};

function run(id: PlatformId, response: RawResponse, url = SEED[id]) {
  const platform = getPlatform(id);
  if (!platform) throw new Error(`unknown platform ${id}`);
  return analyze(platform, response, new URL(url));
}

/** A page bigger than any interstitial, with no listing data. */
const bigUnknownPage = `<html><head><title>Accueil</title></head><body>${'<p>Texte de la page. </p>'.repeat(400)}</body></html>`;

describe('normalizeBody', () => {
  it('undoes JSON, doubly escaped JSON, entity and percent escapes', () => {
    expect(normalizeBody('https:\\u002F\\u002Fa.fr\\/b')).toBe('https://a.fr/b');
    expect(normalizeBody('{\\"a\\":\\\\"b\\\\"}')).toBe('{"a":"b"}');
    expect(normalizeBody('Reference&#32;&#35;18&#46;x')).toBe('Reference #18.x');
    expect(normalizeBody('captcha&#x2d;delivery&#x2E;com')).toBe('captcha-delivery.com');
    expect(normalizeBody('&quot;a&quot;&amp;b %22bad_traffic%22%3A%22ok%22')).toBe('"a"&b "bad_traffic":"ok"');
    expect(normalizeBody('&#99999999;ok')).toBe('&#99999999;ok');
  });
});

describe('laCentraleReference', () => {
  it('turns the first two digits into a letter', () => {
    expect(laCentraleReference(new URL('https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html'))).toBe('E119858725');
    expect(laCentraleReference(new URL('https://www.lacentrale.fr/auto-occasion-annonce-66103802227.html'))).toBe('B103802227');
  });
});

describe('analyze: readable listings', () => {
  it('reads Leboncoin auto despite DataDome traces and i18n "Access denied"/"captcha" strings', () => {
    const a = run(
      'leboncoin-auto',
      raw(fixture('leboncoin-auto-ok.html'), { headers: { 'x-datadome': 'protected' }, cookieNames: ['datadome'] }),
    );
    expect(a.verdict).toBe('lisible');
    expect(a.listingData).toBe(true);
    expect(a.idMatches).toBe(true);
    expect(a.price).toEqual({ found: true, source: 'structured' });
    expect(a.photoCount).toBe(3);
    expect(a.declaredPhotoCount).toBe(3);
    expect(a.embeddedData).toContain('__NEXT_DATA__');
    expect(a.signals.filter((s) => s.strength === 'strong')).toEqual([]);
    expect(a.warnings).toContain('DataDome actif sur le site, page servie');
  });

  it('reads Leboncoin immo and its DPE letter', () => {
    const a = run('leboncoin-immo', raw(fixture('leboncoin-immo-ok.html')));
    expect(a.verdict).toBe('lisible');
    expect(a.dpe).toBe('D');
    expect(a.photoCount).toBe(2);
  });

  it('flags a Leboncoin page that serves another listing', () => {
    const a = run('leboncoin-auto', raw(fixture('leboncoin-auto-ok.html')), 'https://www.leboncoin.fr/ad/voitures/1111111111');
    expect(a.idMatches).toBe(false);
    expect(a.verdict).toBe('partiel');
  });

  it('reads AutoScout24, ignores photos of other listings and surfaces bad_traffic', () => {
    const a = run('autoscout24-fr', raw(fixture('autoscout24-ok.html')));
    expect(a.verdict).toBe('lisible');
    expect(a.photoCount).toBe(3);
    expect(a.badTraffic).toBe('datacenter');
    expect(a.warnings.some((w) => w.includes('bad_traffic=datacenter'))).toBe(true);
  });

  it('reads the doubly escaped SeLoger state blob', () => {
    const a = run('seloger', raw(fixture('seloger-ok.html')));
    expect(a.verdict).toBe('lisible');
    expect(a.price.source).toBe('structured');
    expect(a.photoCount).toBe(2);
    expect(a.declaredPhotoCount).toBe(2);
    expect(a.dpe).toBe('D');
  });

  it('reads La Centrale and keeps only photos of this listing', () => {
    const a = run('lacentrale', raw(fixture('lacentrale-ok.html')));
    expect(a.verdict).toBe('lisible');
    expect(a.photoCount).toBe(3);
  });

  it('reads PAP despite the benign Cloudflare scripts and the Turnstile widget', () => {
    const a = run('pap', raw(fixture('pap-ok.html'), { headers: { 'cf-ray': 'x', server: 'cloudflare' } }));
    expect(a.verdict).toBe('lisible');
    expect(a.photoCount).toBe(2);
    expect(a.dpe).toBe('C');
    expect(a.signals.map((s) => s.id)).toEqual(['cloudflare-present']);
  });

  it('reports a listing blob without price as partial', () => {
    const body = fixture('seloger-ok.html').replace(/av_items|hardFacts/g, 'x').replace(/263200 €/, '');
    const a = run('seloger', raw(body));
    expect(a.verdict).toBe('partiel');
    expect(a.reasons).toContain('prix introuvable');
  });
});

describe('analyze: listing evidence', () => {
  it('recognises a Leboncoin ad by its list_id even if the Next.js route name changes', () => {
    const body = fixture('leboncoin-auto-ok.html').replace('"page":"/ad/[cat]/[id]"', '"page":"/annonce/[slug]"');
    const a = run('leboncoin-auto', raw(body));
    expect(a.idMatches).toBe(true);
    expect(a.verdict).toBe('lisible');
  });

  it('keeps a served ad readable when DataDome flags the request (x-dd-b on a 200)', () => {
    const a = run('leboncoin-auto', raw(fixture('leboncoin-auto-ok.html'), { headers: { 'x-dd-b': '1', 'x-datadome': 'protected' } }));
    expect(a.verdict).toBe('lisible');
    expect(a.signals.find((s) => s.id === 'datadome-flag')?.strength).toBe('weak');
  });

  it('lets the listing data win over a mention of captcha-delivery.com', () => {
    const body = fixture('leboncoin-auto-ok.html').replace('</head>', '<link rel="preconnect" href="https://geo.captcha-delivery.com"></head>');
    expect(run('leboncoin-auto', raw(body)).verdict).toBe('lisible');
  });

  it('requires photos for "lisible": price without photo URLs is partial', () => {
    const body = fixture('leboncoin-auto-ok.html').replace(/img\.leboncoin\.fr|img\.leboncoin\.fr\\u002Fapi|\\u002F\\u002Fimg\.leboncoin\.fr/g, 'img.example.org');
    const a = run('leboncoin-auto', raw(body));
    expect(a.photoCount).toBe(0);
    expect(a.verdict).toBe('partiel');
    expect(a.reasons).toContain('aucune URL de photo reconnue');
  });

  it('ties PAP pages to the listing id of their canonical link, in any attribute order', () => {
    const swapped = fixture('pap-ok.html').replace(
      '<link rel="canonical" href="https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049"/>',
      '<link href="https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049" rel="canonical"/>',
    );
    expect(run('pap', raw(swapped)).idMatches).toBe(true);
    const other = run('pap', raw(fixture('pap-ok.html')), 'https://www.pap.fr/annonces/maison-lyon-r111111111');
    expect(other.idMatches).toBe(false);
    expect(other.verdict).toBe('partiel');
  });

  it('does not take the 410 of another SeLoger micro-app for an expired listing', () => {
    const body = fixture('seloger-ok.html').replace(
      '{\\"app_cldp\\":',
      '{\\"app_agency\\":{\\"data\\":null,\\"error\\":{\\"statusCode\\":410}},\\"app_cldp\\":',
    );
    expect(body).toContain('app_agency');
    expect(run('seloger', raw(body)).verdict).toBe('lisible');
  });
});

describe('analyze: blocked pages', () => {
  it('flags the DataDome hard ban (t=bv)', () => {
    const a = run('leboncoin-auto', raw(fixture('datadome-captcha.html'), { status: 403, headers: { 'x-datadome': 'protected', 'x-dd-b': '1' } }));
    expect(a.verdict).toBe('bloqué');
    expect(a.reasons[0]).toContain('t=bv');
  });

  it('flags a DataDome interstitial served with HTTP 200 and no DataDome header', () => {
    const a = run('lacentrale', raw(fixture('datadome-interstitial.html')));
    expect(a.verdict).toBe('bloqué');
    expect(a.reasons[0]).toContain('rt=i');
  });

  it('flags a Cloudflare challenge', () => {
    const a = run('pap', raw(fixture('cloudflare-challenge.html'), { status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'x' } }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.map((s) => s.id)).toContain('cloudflare-challenge');
  });

  it('flags an entity-encoded Akamai Access Denied page', () => {
    const a = run('autoscout24-fr', raw(fixture('akamai-denied.html'), { status: 403 }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.map((s) => s.id)).toContain('akamai-denied');
  });

  it('flags a CloudFront refusal', () => {
    const a = run('autoscout24-fr', raw(fixture('cloudfront-error.html'), { status: 403, headers: { 'x-cache': 'Error from cloudfront' } }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.map((s) => s.id)).toContain('cloudfront-error');
  });

  it('treats a small page without listing data as blocked', () => {
    expect(run('pap', raw(fixture('js-shell.html'))).verdict).toBe('bloqué');
  });

  it('flags an AWS WAF CAPTCHA (HTTP 405)', () => {
    const body = '<html><head><title></title><script src="https://abc.token.awswaf.com/abc/challenge.js"></script><script>window.gokuProps = {}; AwsWafIntegration.checkForceRefresh()</script></head><body><div id="captcha-container"></div></body></html>';
    const a = run('autoscout24-fr', raw(body, { status: 405 }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.map((s) => s.id)).toContain('aws-waf-challenge');
  });

  it('flags an unlisted 4xx whose page is a captcha', () => {
    expect(run('lacentrale', raw('<html><body>Please solve the captcha to continue</body></html>', { status: 400 })).verdict).toBe('bloqué');
  });

  it('reports a 503 carrying only a weak CDN trace as an error, not a block', () => {
    const page = `<html><head><title>Maintenance</title></head><body>${'<p>Le site est en maintenance, revenez plus tard. </p>'.repeat(120)}</body></html>`;
    const a = run('pap', raw(page, { status: 503, headers: { 'cf-ray': 'x', server: 'cloudflare' } }));
    expect(a.verdict).toBe('erreur');
    expect(a.warnings).toContain('derrière Cloudflare');
  });

  it('separates small pages (interstitial, blocked) from large unknown pages (partial)', () => {
    const text = (n: number) => `<html><head><title>Page</title></head><body><p>${'mot '.repeat(n)}</p></body></html>`;
    const small = text(700);
    const large = text(1600);
    expect(Buffer.byteLength(small)).toBeLessThan(5000);
    expect(Buffer.byteLength(large)).toBeGreaterThan(5000);
    expect(run('pap', raw(small)).verdict).toBe('bloqué');
    expect(run('pap', raw(large)).verdict).toBe('partiel');
  });

  it('treats 429 as blocked and 500 as an error', () => {
    expect(run('lacentrale', raw('Too many requests', { status: 429 })).verdict).toBe('bloqué');
    expect(run('lacentrale', raw('oops', { status: 500 })).verdict).toBe('erreur');
  });
});

describe('analyze: expired and unknown pages', () => {
  it('treats 404 and 410 as expired', () => {
    expect(run('pap', raw('<html><title>Introuvable</title></html>', { status: 404 })).verdict).toBe('expirée');
    expect(run('pap', raw('', { status: 410 })).verdict).toBe('expirée');
  });

  it('recognises in-page expiry markers', () => {
    expect(run('seloger', raw(fixture('seloger-expired.html'))).verdict).toBe('expirée');
    expect(run('pap', raw(fixture('pap-expired.html'))).verdict).toBe('expirée');
  });

  it('reports a large page without listing data as partial, not readable', () => {
    const a = run('leboncoin-auto', raw(bigUnknownPage));
    expect(a.verdict).toBe('partiel');
    expect(a.reasons[0]).toContain('aucune donnée');
  });

  it('keeps the word captcha on a normal page as a weak signal', () => {
    const a = run('pap', raw(fixture('pap-ok.html').replace('</main>', '<p>Protégé par reCAPTCHA</p></main>')));
    expect(a.verdict).toBe('lisible');
  });
});

describe('analyze: performance', () => {
  it('handles a 5 MB page quickly', () => {
    const body = `<html><body>${'<div class="x">"price": abc \\u002F &#35; captcha</div>'.repeat(100_000)}</body></html>`;
    const started = performance.now();
    const a = run('seloger', raw(body));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(a.verdict).toBe('partiel');
  });
});
