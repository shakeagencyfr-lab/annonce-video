import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_SPECS, sheetSpecs } from '@/lib/render/specs';
import { parseSheet, type PropertySheet, type VehicleSheet } from '@/lib/sheet';

const auto = parseSheet(JSON.parse(readFileSync('tests/fixtures/sheets/auto-308.json', 'utf8'))) as VehicleSheet;

const NNBSP = ' ';

const immo: PropertySheet = {
  vertical: 'immo',
  platform: 'seloger',
  sourceUrl: 'https://www.seloger.com/annonce/achat/x/y/marseille-13000/26ZCAGW19827',
  transaction: 'vente',
  propertyType: 'Appartement',
  currency: 'EUR',
  surfaceM2: 64.7,
  rooms: 3,
  bedrooms: 1,
  landM2: 1200,
  features: [],
  photos: [],
};

describe('sheetSpecs', () => {
  it('lists the vehicle facts of the sheet, as they are, in the template order', () => {
    expect(sheetSpecs(auto, 'fr')).toEqual([
      { label: 'Année', value: '2019', chip: '2019' },
      { label: 'Kilométrage', value: `68${NNBSP}000 km`, chip: `68${NNBSP}000 km` },
      { label: 'Énergie', value: 'Essence', chip: 'Essence' },
      { label: 'Boîte', value: 'Manuelle', chip: 'Manuelle' },
      { label: 'Puissance', value: '130 ch', chip: '130 ch' },
    ]);
  });

  it('leaves out what the sheet does not give', () => {
    const bare: VehicleSheet = { ...auto, year: undefined, mileageKm: undefined, gearbox: undefined, powerHp: undefined };
    expect(sheetSpecs(bare, 'fr').map((s) => s.label)).toEqual(['Énergie']);
  });

  it('lists the property facts, with decimals kept and counts in words on the chips', () => {
    expect(sheetSpecs(immo, 'fr')).toEqual([
      { label: 'Surface', value: '64,7 m²', chip: '64,7 m²' },
      { label: 'Pièces', value: '3', chip: '3 pièces' },
      { label: 'Chambres', value: '1', chip: '1 chambre' },
      { label: 'Terrain', value: `1${NNBSP}200 m²`, chip: `Terrain 1${NNBSP}200 m²` },
    ]);
  });

  it('never shows more than the panel can take', () => {
    expect(sheetSpecs({ ...immo, floor: '2e' }, 'fr')).toHaveLength(MAX_SPECS);
  });

  it('writes labels, units and numbers in the video language', () => {
    expect(sheetSpecs(auto, 'de').map((s) => s.value)).toEqual(['2019', '68.000 km', 'Essence', 'Manuelle', '130 PS']);
    expect(sheetSpecs(immo, 'nl')[1]).toEqual({ label: 'Kamers', value: '3', chip: '3 kamers' });
  });
});
