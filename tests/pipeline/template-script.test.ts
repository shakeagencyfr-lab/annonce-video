import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSheet, type PropertySheet } from '@/lib/sheet';
import { formatPrice, templateScripts } from '@/lib/pipeline/template-script';

const auto = parseSheet(JSON.parse(readFileSync(join(__dirname, '../fixtures/sheets/auto-308.json'), 'utf8')));

describe('templateScripts', () => {
  it('builds both variants from sheet fields only', () => {
    const { social } = templateScripts(auto, 'fr');
    const socialText = social.segments.map((s) => s.text).join(' ');
    expect(socialText).toContain('Peugeot 308 de 2019');
    expect(socialText).toContain('68 000 kilomètres');
    expect(socialText).toContain('Caméra de recul');
    expect(social.overlays.price).toBe('15 990 €');
    expect(social.overlays.contact).toBe('Garage des Tests · Lyon');
    for (const seg of social.segments) for (const f of seg.facts) expect(f).toMatch(/^[a-zA-Z]+(\[\d+\])?$/);
  });

  it('never states the price nor a contact in the listing variant', () => {
    const { listing } = templateScripts({ ...auto, phone: '06 12 34 56 78' }, 'fr');
    const text = listing.segments.map((s) => s.text).join(' ');
    expect(text).not.toMatch(/€|prix|15 990|06 12/i);
    expect(listing.overlays.price).toBeUndefined();
    expect(listing.overlays.contact).toBeUndefined();
  });

  it('omits what the sheet does not say', () => {
    const bare = parseSheet({
      ...auto,
      year: undefined,
      mileageKm: undefined,
      warranty: undefined,
      equipment: [],
      fuel: undefined,
      gearbox: undefined,
      powerHp: undefined,
    });
    const text = templateScripts(bare, 'fr').social.segments.map((s) => s.text).join(' ');
    expect(text).not.toMatch(/kilomètres|Équipée|Garantie|de \d{4}/);
  });

  it('covers property sheets and refuses other languages offline', () => {
    const immo: PropertySheet = {
      vertical: 'immo',
      platform: 'seloger',
      sourceUrl: 'https://www.seloger.com/annonce/achat/x/y/z/26ZCAGW19827',
      transaction: 'vente',
      propertyType: 'Appartement',
      currency: 'EUR',
      price: 263200,
      city: 'Marseille',
      surfaceM2: 64.7,
      rooms: 3,
      features: ['Balcon', 'Cave'],
      photos: [],
      dpe: 'D',
    };
    const { social, listing } = templateScripts(immo, 'fr');
    expect(social.segments[0]?.text).toBe('Appartement à Marseille.');
    expect(social.segments[1]?.text).toBe('64,7 m², 3 pièces.');
    expect(listing.overlays.price).toBeUndefined();
    expect(() => templateScripts(immo, 'de')).toThrow(/français/);
  });

  it('formats prices with narrow no-break spaces', () => {
    expect(formatPrice(1234567, 'EUR')).toBe('1 234 567 €');
    expect(formatPrice(9000, 'CHF')).toBe('CHF 9 000');
  });
});
