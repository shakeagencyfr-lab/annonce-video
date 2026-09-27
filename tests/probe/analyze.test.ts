import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, normalizeBody, type RawResponse } from '@/lib/probe/analyze';
import { getPlatform, type PlatformId } from '@/lib/probe/platforms';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures/probe', name), 'utf8');

function raw(body: string, overrides: Partial<RawResponse> = {}): RawResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    cookieNames: [],
    body,
    bytes: body.length,
    truncated: false,
    ...overrides,
  };
}

function platform(id: PlatformId) {
  const p = getPlatform(id);
  if (!p) throw new Error(`unknown platform ${id}`);
  return p;
}

describe('normalizeBody', () => {
  it('undoes JSON and numeric-entity escapes', () => {
    expect(normalizeBody('https:\\u002F\\u002Fa.fr\\/b')).toBe('https://a.fr/b');
    expect(normalizeBody('Reference&#32;&#35;18&#46;x')).toBe('Reference #18.x');
    expect(normalizeBody('&#x2F;&quot;')).toBe('/"');
    expect(normalizeBody('&#99999999;ok')).toBe('&#99999999;ok');
  });
});

describe('analyze', () => {
  it('reads a Leboncoin page served normally despite the DataDome tag', () => {
    const a = analyze(platform('leboncoin-auto'), raw(fixture('leboncoin-auto-ok.html'), { headers: { 'x-datadome': 'protected' }, cookieNames: ['datadome'] }));
    expect(a.verdict).toBe('lisible');
    expect(a.price).toEqual({ found: true, source: 'structured' });
    expect(a.photoCount).toBe(3);
    expect(a.embeddedData).toContain('__NEXT_DATA__');
    expect(a.signals.map((s) => s.id)).toEqual(['datadome-present']);
    expect(a.warnings).toContain('DataDome actif sur le site, page servie');
  });

  it('flags a DataDome captcha page as blocked', () => {
    const a = analyze(platform('leboncoin-auto'), raw(fixture('datadome-captcha.html'), { status: 403, headers: { 'x-datadome': 'protected', 'x-dd-b': '1' } }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.some((s) => s.id === 'datadome-challenge' && s.strength === 'strong')).toBe(true);
  });

  it('flags a DataDome captcha page as blocked even with HTTP 200', () => {
    const a = analyze(platform('seloger'), raw(fixture('datadome-captcha.html')));
    expect(a.verdict).toBe('bloqué');
  });

  it('flags a Cloudflare challenge as blocked', () => {
    const a = analyze(platform('pap'), raw(fixture('cloudflare-challenge.html'), { status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'x' } }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.map((s) => s.id)).toContain('cloudflare-challenge');
  });

  it('flags an entity-encoded Akamai Access Denied page as blocked', () => {
    const a = analyze(platform('autoscout24-fr'), raw(fixture('akamai-denied.html'), { status: 403 }));
    expect(a.verdict).toBe('bloqué');
    expect(a.signals.map((s) => s.id)).toContain('akamai-denied');
  });

  it('reads AutoScout24 and surfaces bad_traffic', () => {
    const a = analyze(platform('autoscout24-fr'), raw(fixture('autoscout24-ok.html')));
    expect(a.verdict).toBe('lisible');
    expect(a.photoCount).toBe(3);
    expect(a.badTraffic).toBe('datacenter');
    expect(a.warnings.some((w) => w.includes('bad_traffic=datacenter'))).toBe(true);
  });

  it('marks a page with a photo but no structured price as partial', () => {
    const a = analyze(platform('seloger'), raw(fixture('seloger-partial.html')));
    expect(a.verdict).toBe('partiel');
    expect(a.photoCount).toBe(1);
    expect(a.price.found).toBe(false);
    expect(a.dpeHint).toBe(true);
  });

  it('treats an empty JavaScript shell as blocked', () => {
    const a = analyze(platform('pap'), raw(fixture('js-shell.html')));
    expect(a.verdict).toBe('bloqué');
  });

  it('treats 404 and 410 as an expired listing', () => {
    expect(analyze(platform('pap'), raw('<html><title>Introuvable</title></html>', { status: 404 })).verdict).toBe('expirée');
    expect(analyze(platform('pap'), raw('', { status: 410 })).verdict).toBe('expirée');
  });

  it('treats 429 as blocked and 500 as an error', () => {
    expect(analyze(platform('lacentrale'), raw('Too many requests', { status: 429 })).verdict).toBe('bloqué');
    expect(analyze(platform('lacentrale'), raw('oops', { status: 500 })).verdict).toBe('erreur');
  });

  it('does not treat the word captcha on a normal page as a block', () => {
    const body = fixture('leboncoin-auto-ok.html').replace('</main>', '<p>Protégé par reCAPTCHA</p></main>');
    const a = analyze(platform('leboncoin-auto'), raw(body));
    expect(a.verdict).toBe('lisible');
    expect(a.signals.find((s) => s.id === 'captcha-word')?.strength).toBe('weak');
  });
});
