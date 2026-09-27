import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canHandle, flattenEquipment, htmlToText, read } from '@/lib/readers/autoscout24';
import { ReadError } from '@/lib/readers/errors';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');

const UUID = 'a1b2c3d4-0000-4000-8000-000000000001';
const URL_ = `https://www.autoscout24.fr/offres/peugeot-308-1-2-puretech-130-allure-essence-gris-${UUID}`;
const IMG = 'https://prod.pictures.autoscout24.net/listing-images/';

function fakeFetch(body: string, init: ResponseInit = { status: 200 }) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(body, init));
}

/** A listing page whose __NEXT_DATA__ holds these listing details. */
function page(listingDetails: object): string {
  const blob = JSON.stringify({ props: { pageProps: { listingDetails } }, page: '/offers/[slug]' });
  return `<!DOCTYPE html><html><body><main>Annonce</main><script id="__NEXT_DATA__" type="application/json">${blob}</script></body></html>`;
}

async function readError(promise: Promise<unknown>): Promise<ReadError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReadError);
  return err as ReadError;
}

describe('canHandle', () => {
  it('accepts a single AutoScout24.fr listing only', () => {
    expect(canHandle(URL_)).toBe(true);
    expect(canHandle(`${URL_}?source=homepage#photos`)).toBe(true);
    expect(canHandle('https://www.autoscout24.fr/lst/peugeot/308')).toBe(false);
    expect(canHandle(URL_.replace('https:', 'http:'))).toBe(false);
    expect(canHandle('https://www.autoscout24.ch/fr/d/peugeot-308-12345')).toBe(false);
    expect(canHandle('https://www.leboncoin.fr/ad/voitures/3209507340')).toBe(false);
    expect(canHandle('pas une url')).toBe(false);
  });
});

describe('read', () => {
  it('fetches the listing once, as a browser, without query string nor redirects', async () => {
    const fetch = fakeFetch(fixture('readers/autoscout24-listing.html'));
    await read(`${URL_}?source=homepage#photos`, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0]!;
    expect(input).toBe(URL_);
    expect(init?.redirect).toBe('manual');
    expect((init?.headers as Record<string, string>)['user-agent']).toMatch(/Chrome\//);
  });

  it('maps the listing details to a vehicle sheet', async () => {
    const sheet = await read(URL_, { fetch: fakeFetch(fixture('readers/autoscout24-listing.html')) });
    expect(sheet).toEqual({
      vertical: 'auto',
      platform: 'autoscout24-fr',
      sourceUrl: URL_,
      title: 'Peugeot 308 1.2 PureTech 130 S&S Allure',
      make: 'Peugeot',
      model: '308',
      version: '1.2 PureTech 130 S&S Allure',
      year: 2019,
      mileageKm: 68000,
      fuel: 'Essence',
      gearbox: 'Boîte manuelle',
      powerHp: 130,
      price: 15990,
      currency: 'EUR',
      city: 'Lyon',
      postalCode: '69003',
      phone: '01 99 00 12 34',
      sellerType: 'pro',
      sellerName: 'Garage des Tests',
      equipment: [
        'Climatisation automatique',
        'Régulateur de vitesse',
        'Apple CarPlay',
        'Bluetooth',
        'ABS',
        'Caméra de recul',
        'Jantes alliage',
      ],
      description:
        'Peugeot 308 Allure, première main.\n- Carnet d\'entretien à jour\n- Contrôle technique OK\nReprise possible & financement : nous consulter.',
      // One per photo, at 1920x1080, this listing only: no size duplicate, no similar ad, no foreign host.
      photos: [
        { url: `${IMG}${UUID}_11111111-2222-3333-4444-555555555555.jpg/1920x1080.webp` },
        { url: `${IMG}${UUID}_66666666-7777-8888-9999-000000000000.jpg/1920x1080.webp` },
        { url: `${IMG}${UUID}_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg/1920x1080.webp` },
      ],
    });
    // Nothing guessed: no warranty in the data, so none in the sheet.
    expect('warranty' in sheet).toBe(false);
    // No HTML kept (rule 2).
    expect(JSON.stringify(sheet)).not.toMatch(/<[a-z/]/i);
  });

  it('omits absent fields and falls back on the tracking block for power and gearbox only', async () => {
    const html = page({
      id: UUID,
      vehicle: { make: 'Renault', model: 'Clio' },
      prices: { dealer: { priceRaw: 8900 } },
      seller: { isDealer: false },
      images: [],
      adTargetingString: JSON.stringify({ stmak: 'Renault', stmod: 'Clio', sthp: '90', stkw: '66', gear: 'A', styea: '2015', fuel: 'B' }),
    });
    const sheet = await read(URL_, { fetch: fakeFetch(html) });
    expect(sheet).toEqual({
      vertical: 'auto',
      platform: 'autoscout24-fr',
      sourceUrl: URL_,
      title: 'Renault Clio',
      make: 'Renault',
      model: 'Clio',
      powerHp: 90,
      gearbox: 'Automatique',
      price: 8900,
      currency: 'EUR',
      sellerType: 'particulier',
      equipment: [],
      photos: [],
    });
    for (const key of ['year', 'mileageKm', 'fuel', 'city', 'postalCode', 'phone', 'sellerName', 'description', 'version']) {
      expect(key in sheet, key).toBe(false);
    }
  });

  it('never takes a bare code for a label', async () => {
    const html = page({
      vehicle: { make: 'Renault', model: 'Clio', fuelCategory: 'B', transmissionType: { raw: 'M' } },
      seller: { isDealer: true },
      adTargetingString: JSON.stringify({ fuel: 'B', gear: 'M' }),
    });
    const sheet = await read(URL_, { fetch: fakeFetch(html) });
    expect('fuel' in sheet).toBe(false);
    // The tracking code "M" is documented: translated, not shown as is.
    expect(sheet.gearbox).toBe('Manuelle');
  });

  it('never converts kW to horsepower', async () => {
    const html = page({
      vehicle: { make: 'Renault', model: 'Clio', rawPowerInKw: 66 },
      seller: { isDealer: true },
      adTargetingString: JSON.stringify({ stkw: '66' }),
    });
    const sheet = await read(URL_, { fetch: fakeFetch(html) });
    expect('powerHp' in sheet).toBe(false);
  });

  it('refuses a block page with the anti-bot reason', async () => {
    const err = await readError(read(URL_, { fetch: fakeFetch(fixture('probe/cloudfront-error.html'), { status: 403 }) }));
    expect(err.reason).toBe('anti-bot');
    expect(err.message).toMatch(/AutoScout24 : le site a refusé la lecture \(CloudFront : requête refusée ; HTTP 403\)/);
    expect(err.message).not.toMatch(/<html/i);
  });

  it('refuses a DataDome captcha served with 200', async () => {
    const err = await readError(read(URL_, { fetch: fakeFetch(fixture('probe/datadome-captcha.html')) }));
    expect(err.reason).toBe('anti-bot');
    expect(err.message).toMatch(/DataDome/);
  });

  it('refuses a page without the listing data', async () => {
    const err = await readError(read(URL_, { fetch: fakeFetch(`<html><body>${'Texte de la page. '.repeat(50)}</body></html>`) }));
    expect(err.reason).toBe('no-data');
  });

  it('refuses an unexpected HTTP status', async () => {
    const err = await readError(read(URL_, { fetch: fakeFetch(`<html><body>${'Erreur. '.repeat(100)}</body></html>`, { status: 500 }) }));
    expect(err.reason).toBe('http');
    expect(err.message).toMatch(/HTTP 500/);
  });

  it('refuses removed listings (redirect, 404)', async () => {
    const redirect = fakeFetch('', { status: 301, headers: { location: 'https://www.autoscout24.fr/lst/peugeot/308' } });
    expect((await readError(read(URL_, { fetch: redirect }))).reason).toBe('expired');
    expect((await readError(read(URL_, { fetch: fakeFetch('', { status: 404 }) }))).reason).toBe('expired');
  });

  it('follows a redirect that stays on the listing (www host, renamed slug)', async () => {
    const html = fixture('readers/autoscout24-listing.html');
    const renamed = `https://www.autoscout24.fr/offres/peugeot-308-allure-${UUID}`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://autoscout24.fr/')) {
        return new Response('', { status: 301, headers: { location: `${renamed}?from=redirect` } });
      }
      return new Response(html);
    });
    const sheet = await read(URL_.replace('www.', ''), { fetch });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([URL_.replace('www.', ''), renamed]);
    expect(sheet.sourceUrl).toBe(renamed);
    expect(sheet.photos).toHaveLength(3);
  });

  it('does not follow a redirect to another page, nor endlessly', async () => {
    const offListing = fakeFetch('', { status: 302, headers: { location: `https://www.autoscout24.fr/offres/autre-annonce-ffffffff-0000-4000-8000-000000000000` } });
    expect((await readError(read(URL_, { fetch: offListing }))).reason).toBe('expired');
    expect(offListing).toHaveBeenCalledTimes(1);

    let n = 0;
    const loop = vi.fn(async () => new Response('', { status: 301, headers: { location: `/offres/slug-${++n}-${UUID}` } }));
    expect((await readError(read(URL_, { fetch: loop }))).reason).toBe('expired');
    expect(loop).toHaveBeenCalledTimes(3);
  });

  it('refuses a page about another listing', async () => {
    const html = page({ id: 'ffffffff-0000-4000-8000-000000000000', vehicle: { make: 'Renault', model: 'Clio' }, seller: { isDealer: true } });
    expect((await readError(read(URL_, { fetch: fakeFetch(html) }))).reason).toBe('wrong-listing');
  });

  it('refuses listing data without make or seller type', async () => {
    // The tracking block never names the vehicle: stmak may be an id.
    const noMake = page({ vehicle: { model: 'Clio' }, seller: { isDealer: true }, adTargetingString: JSON.stringify({ stmak: '55', stmod: '1000' }) });
    expect((await readError(read(URL_, { fetch: fakeFetch(noMake) }))).reason).toBe('missing-field');
    const noSeller = page({ vehicle: { make: 'Renault', model: 'Clio' } });
    expect((await readError(read(URL_, { fetch: fakeFetch(noSeller) }))).reason).toBe('missing-field');
  });

  it('reports network errors and timeouts in French', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await readError(read(URL_, { fetch: down }));
    expect(err.reason).toBe('network');
    expect(err.message).toMatch(/erreur réseau/);
    const slow = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const timeout = await readError(read(URL_, { fetch: slow }));
    expect(timeout.reason).toBe('network');
    expect(timeout.message).toMatch(/n’a pas répondu en 20 s/);
  });

  it('refuses a URL it does not handle without fetching', async () => {
    const fetch = fakeFetch('');
    expect((await readError(read('https://www.autoscout24.fr/lst/peugeot', { fetch }))).reason).toBe('unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('flattens equipment given as a list or by category', () => {
    expect(flattenEquipment(['GPS', { name: 'ABS' }, 3, null])).toEqual(['GPS', 'ABS']);
    expect(flattenEquipment({ a: [{ id: 1, name: ' GPS ' }], b: 'pas une liste', c: [{ id: 2, name: 'GPS' }] })).toEqual(['GPS']);
    expect(flattenEquipment(undefined)).toEqual([]);
  });

  it('turns an HTML description into plain text', () => {
    expect(htmlToText('<b>Tr&egrave;s</b>&nbsp;bon &eacute;tat<br>&#8364; &#x20AC; &unknown;<script>alert(1)</script>')).toBe(
      'Très bon état\n€ € &unknown;',
    );
  });
});
