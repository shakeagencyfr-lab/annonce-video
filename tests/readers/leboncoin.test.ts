import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadError } from '@/lib/readers/errors';
import { canHandle, descriptionBullets, fromExport, isExport, read } from '@/lib/readers/leboncoin';

type Json = Record<string, any>;

const load = (name: string): Json => JSON.parse(readFileSync(join(__dirname, '../fixtures/readers', name), 'utf8'));
const IMG = 'https://img.leboncoin.fr/api/v1/lbcpb1/images/';

function thrown(fn: () => unknown): ReadError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ReadError);
    return err as ReadError;
  }
  throw new Error('no error thrown');
}

function setAttribute(ad: Json, key: string, attribute: Json | null) {
  ad.attributes = ad.attributes.filter((a: Json) => a.key !== key);
  if (attribute) ad.attributes.push({ key, ...attribute });
}

describe('canHandle', () => {
  it('accepts single car, sale and rental ads only', () => {
    expect(canHandle('https://www.leboncoin.fr/ad/voitures/3209507340')).toBe(true);
    expect(canHandle('https://www.leboncoin.fr/ad/ventes_immobilieres/3259370552')).toBe(true);
    expect(canHandle('https://www.leboncoin.fr/ad/locations/3259370553')).toBe(true);
    expect(canHandle('https://www.leboncoin.fr/recherche?category=2')).toBe(false);
    expect(canHandle('https://www.leboncoin.fr/c/voitures')).toBe(false);
    expect(canHandle('https://www.leboncoin.fr/ad/motos/3209507341')).toBe(false);
    expect(canHandle('http://www.leboncoin.fr/ad/voitures/3209507340')).toBe(false);
    expect(canHandle('https://www.autoscout24.fr/offres/x')).toBe(false);
  });
});

describe('read', () => {
  it('never fetches and explains how to export the listing', async () => {
    const err = await read('https://www.leboncoin.fr/ad/voitures/3209507340').then(
      () => null,
      (e: unknown) => e as ReadError,
    );
    expect(err).toBeInstanceOf(ReadError);
    expect(err?.reason).toBe('server-read-blocked');
    expect(err?.message).toMatch(/DataDome/);
    expect(err?.message).toMatch(/npm run bookmarklet/);
    expect(err?.message).toMatch(/make-video/);
  });
});

describe('fromExport: car', () => {
  it('maps the ad to a vehicle sheet', () => {
    const exported = load('leboncoin-auto-export.json');
    expect(isExport(exported)).toBe(true);
    expect(fromExport(exported)).toEqual({
      vertical: 'auto',
      platform: 'leboncoin',
      sourceUrl: 'https://www.leboncoin.fr/ad/voitures/3209507340',
      title: 'Peugeot 308 1.2 PureTech 130ch Allure',
      // Labels, not values: "PEUGEOT" and "Peugeot_308" are keys.
      make: 'Peugeot',
      model: '308',
      version: '1.2 PureTech 130ch S&S BVM6 Allure',
      year: 2019,
      mileageKm: 68000,
      fuel: 'Essence',
      gearbox: 'Manuelle',
      // DIN power, not the fiscal "horsepower" (7).
      powerHp: 130,
      price: 15990,
      currency: 'EUR',
      city: 'Lyon',
      postalCode: '69003',
      sellerType: 'pro',
      sellerName: 'Garage des Tests',
      sellerSiren: '123456789',
      warranty: 'Garantie 12 mois',
      equipment: ['Caméra de recul', 'Apple CarPlay', 'Régulateur de vitesse'],
      description: "Première main, carnet d'entretien à jour.\nContrôle technique OK, véhicule non fumeur.",
      // Large photos, the non-hex "gh" id kept, the duplicate and the foreign host dropped.
      photos: [
        { url: `${IMG}aa/bb/cc/aabbcc0011223344556677889900aabbccddeeff.jpg?rule=ad-large` },
        { url: `${IMG}gh/4k/2m/gh4k2m0011223344556677889900aabbccddeeff.jpg?rule=ad-large` },
        { url: `${IMG}11/22/33/1122330011223344556677889900aabbccddeeff.jpg?rule=ad-large` },
      ],
    });
  });

  it('never takes the fiscal horsepower as the power, and leaves the phone absent', () => {
    const exported = load('leboncoin-auto-export.json');
    setAttribute(exported.ad, 'horse_power_din', null);
    const sheet = fromExport(exported);
    expect(sheet.vertical).toBe('auto');
    expect('powerHp' in sheet).toBe(false);
    expect('phone' in sheet).toBe(false);
  });

  it('prefers any label to a value for the make and model', () => {
    const exported = load('leboncoin-auto-export.json');
    setAttribute(exported.ad, 'brand', { value: 'PEUGEOT' });
    setAttribute(exported.ad, 'model', { value: 'Peugeot_308' });
    expect(fromExport(exported)).toMatchObject({ make: 'Peugeot', model: '308' });
  });

  it('never takes the u_car_model key for the model name', () => {
    const exported = load('leboncoin-auto-export.json');
    setAttribute(exported.ad, 'u_car_model', { value: 'Peugeot_308' });
    const err = thrown(() => fromExport(exported));
    expect(err.reason).toBe('missing-field');
    expect(err.message).toMatch(/model/);
  });

  it('omits what the ad does not state', () => {
    const exported = load('leboncoin-auto-export.json');
    const { ad } = exported;
    ad.attributes = ad.attributes.filter((a: Json) => ['u_car_brand', 'u_car_model'].includes(a.key));
    ad.owner = { type: 'private', name: 'Jean' };
    delete ad.body;
    delete ad.location;
    ad.price = [];
    delete ad.price_cents;
    ad.images = { nb_images: 1, urls: [`${IMG}aa/bb/cc/aabbcc0011223344556677889900aabbccddeeff.jpg?rule=ad-image`] };
    expect(fromExport(exported)).toEqual({
      vertical: 'auto',
      platform: 'leboncoin',
      sourceUrl: 'https://www.leboncoin.fr/ad/voitures/3209507340',
      title: 'Peugeot 308 1.2 PureTech 130ch Allure',
      make: 'Peugeot',
      model: '308',
      currency: 'EUR',
      sellerType: 'particulier',
      sellerName: 'Jean',
      equipment: [],
      // Without urls_large, the regular size.
      photos: [{ url: `${IMG}aa/bb/cc/aabbcc0011223344556677889900aabbccddeeff.jpg?rule=ad-image` }],
    });
  });

  it('refuses an ad without make', () => {
    const exported = load('leboncoin-auto-export.json');
    setAttribute(exported.ad, 'u_car_brand', null);
    const err = thrown(() => fromExport(exported));
    expect(err.reason).toBe('missing-field');
    expect(err.message).toMatch(/make/);
  });
});

describe('fromExport: real estate', () => {
  it('maps a sale to a property sheet with its DPE', () => {
    expect(fromExport(load('leboncoin-immo-export.json'))).toEqual({
      vertical: 'immo',
      platform: 'leboncoin',
      sourceUrl: 'https://www.leboncoin.fr/ad/ventes_immobilieres/3259370552',
      transaction: 'vente',
      propertyType: 'Maison',
      price: 349000,
      currency: 'EUR',
      surfaceM2: 120,
      landM2: 500,
      rooms: 5,
      bedrooms: 3,
      city: 'Marseille',
      postalCode: '13013',
      dpe: 'D',
      ges: 'B',
      features: [],
      description: 'Maison lumineuse avec jardin, proche écoles et commerces.',
      agencyName: 'Agence des Tests',
      photos: [
        { url: `${IMG}dd/ee/ff/ddeeff0011223344556677889900aabbccddeeff.jpg?rule=ad-large` },
        { url: `${IMG}12/34/56/1234560011223344556677889900aabbccddeeff.jpg?rule=ad-large` },
      ],
    });
  });

  it('maps a rental; a blank DPE ("v") or "Non renseigné" stays absent', () => {
    const exported = load('leboncoin-immo-export.json');
    exported.url = 'https://www.leboncoin.fr/ad/locations/3259370552';
    exported.ad.category_id = '10';
    exported.ad.owner = { type: 'private', name: 'Marie' };
    setAttribute(exported.ad, 'real_estate_type', { value: '2', value_label: 'Appartement' });
    setAttribute(exported.ad, 'energy_rate', { value: 'v', value_label: 'Vierge' });
    setAttribute(exported.ad, 'ges', { value: 'Non renseigné', value_label: 'Non renseigné' });
    setAttribute(exported.ad, 'floor_number', { value: '3' });
    setAttribute(exported.ad, 'land_plot_surface', null);
    const sheet = fromExport(exported);
    expect(sheet).toMatchObject({ vertical: 'immo', transaction: 'location', propertyType: 'Appartement', floor: '3' });
    for (const key of ['dpe', 'ges', 'agencyName', 'landM2']) expect(key in sheet, key).toBe(false);
  });

  // Shaped like a real exported house (2026-09-28): ticked features, a district, and
  // floor_number filled in for a house.
  it('maps ticked features and the district; a house has no floor', () => {
    const exported = load('leboncoin-immo-export.json');
    setAttribute(exported.ad, 'outside_access', {
      value: '',
      values: ['terrace', 'garden'],
      value_label: 'Terrasse, Jardin',
      values_label: ['Terrasse', 'Jardin'],
    });
    setAttribute(exported.ad, 'specificities', {
      value: '',
      values: ['with_garage_or_parking_spot', 'cellar'],
      value_label: 'Avec garage ou place de parking, Cave',
      values_label: ['Avec garage ou place de parking', 'Cave'],
    });
    // Codes without labels are never copied.
    setAttribute(exported.ad, 'heating_mode', { value: 'electric', values: ['electric'] });
    setAttribute(exported.ad, 'floor_number', { value: '1', values: ['1'], value_label: '1' });
    setAttribute(exported.ad, 'district_visibility', { value: 'true', values: ['true'] });
    exported.ad.location = { ...exported.ad.location, city_label: 'Marseille 13013 Château-Gombert', district: 'Château-Gombert' };
    exported.ad.body = 'Maison lumineuse.\n- Piscine\n- cave';
    const sheet = fromExport(exported);
    expect(sheet).toMatchObject({
      propertyType: 'Maison',
      city: 'Marseille',
      district: 'Château-Gombert',
      features: ['Terrasse', 'Jardin', 'Avec garage ou place de parking', 'Cave', 'Piscine'],
    });
    expect('floor' in sheet).toBe(false);

    setAttribute(exported.ad, 'district_visibility', { value: 'false', values: ['false'] });
    setAttribute(exported.ad, 'real_estate_type', { value: '2', value_label: 'Appartement' });
    const flat = fromExport(exported);
    expect('district' in flat).toBe(false);
    expect(flat).toMatchObject({ propertyType: 'Appartement', floor: '1' });
  });

  it('refuses an ad without property type', () => {
    const exported = load('leboncoin-immo-export.json');
    setAttribute(exported.ad, 'real_estate_type', null);
    expect(thrown(() => fromExport(exported)).reason).toBe('missing-field');
  });
});

describe('fromExport: refused files', () => {
  it('refuses other categories', () => {
    const exported = load('leboncoin-auto-export.json');
    exported.url = 'https://www.leboncoin.fr/ad/motos/3209507340';
    exported.ad.category_id = '3';
    const err = thrown(() => fromExport(exported));
    expect(err.reason).toBe('unsupported');
    expect(err.message).toMatch(/catégorie 3 non prise en charge/);
  });

  it.each<[string, (e: Json) => void, string]>([
    ['another source', (e) => (e.source = 'seloger'), 'invalid-input'],
    ['another version', (e) => (e.version = 2), 'invalid-input'],
    ['no ad', (e) => delete e.ad, 'invalid-input'],
    ['a bad date', (e) => (e.exportedAt = 'hier'), 'invalid-input'],
    ['a search page URL', (e) => (e.url = 'https://www.leboncoin.fr/recherche?category=2'), 'invalid-input'],
    ['a foreign URL', (e) => (e.url = 'https://www.leboncoin.fr.example.com/ad/voitures/3209507340'), 'invalid-input'],
    ['another listing id', (e) => (e.ad.list_id = 3209507341), 'wrong-listing'],
    ['a category that does not match the URL', (e) => (e.ad.category_id = '9'), 'wrong-listing'],
  ])('refuses an envelope with %s', (_, tamper, reason) => {
    const exported = load('leboncoin-auto-export.json');
    tamper(exported);
    const err = thrown(() => fromExport(exported));
    expect(err.reason).toBe(reason);
    expect(err.message).toMatch(/^Leboncoin : /);
  });
});

describe('pro ads shaped like real 2026 exports', () => {
  it('names the shop buyers see, not the account behind it', () => {
    const exported = load('leboncoin-auto-export.json');
    exported.ad.owner = { ...exported.ad.owner, type: 'pro', name: 'RS AUTOMOBILES' };
    setAttribute(exported.ad, 'store_name', { value: 'VOGUE AUTOMOBILES', values: ['VOGUE AUTOMOBILES'], value_label: 'VOGUE AUTOMOBILES' });
    const sheet = fromExport(exported);
    expect(sheet.vertical === 'auto' && sheet.sellerName).toBe('VOGUE AUTOMOBILES');
  });

  it('takes the equipment from the bullet list of the description when no attribute lists it', () => {
    const exported = load('leboncoin-auto-export.json');
    setAttribute(exported.ad, 'vehicle_specifications', null);
    exported.ad.body = [
      'Audi Q2, première main, garantie 12 mois.',
      '',
      'OPTIONS ET EQUIPEMENTS :',
      'Conduite',
      '- Régulateur de vitesse',
      '- Radar de stationnement AR',
      '• Sièges avant chauffants',
      '- régulateur de vitesse',
      '-pas une puce',
      'Kilométrage garanti.',
    ].join('\n');
    const sheet = fromExport(exported);
    expect(sheet.vertical === 'auto' && sheet.equipment).toEqual([
      'Régulateur de vitesse',
      'Radar de stationnement AR',
      'Sièges avant chauffants',
    ]);
  });

  it('keeps listed equipment attributes first', () => {
    const exported = load('leboncoin-auto-export.json');
    exported.ad.body = '- Toit ouvrant';
    const sheet = fromExport(exported);
    expect(sheet.vertical === 'auto' && sheet.equipment).not.toContain('Toit ouvrant');
  });

  it('caps and cleans bullet items', () => {
    expect(descriptionBullets(undefined)).toEqual([]);
    expect(descriptionBullets(`- ${'x'.repeat(81)}\n-  Deux   espaces \n- a`)).toEqual(['Deux espaces']);
    expect(descriptionBullets(Array.from({ length: 200 }, (_, i) => `- item ${i}`).join('\n'))).toHaveLength(150);
  });
});
