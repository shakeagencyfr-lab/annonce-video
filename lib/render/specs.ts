import type { Language } from '../pipeline/types';
import type { Sheet } from '../sheet';

/**
 * Key facts written on screen, taken as they are from the sheet (rule 3): a chip in
 * the 9:16 header, a labelled row in the 16:9 side panel. Deterministic, so nothing
 * shown here depends on Claude.
 */
export type Spec = { label: string; value: string; chip: string };

type Words = {
  locale: string;
  year: string;
  mileage: string;
  fuel: string;
  gearbox: string;
  power: string;
  hp: string;
  surface: string;
  land: string;
  rooms: string;
  bedrooms: string;
  floor: string;
  roomCount: (n: number) => string;
  bedroomCount: (n: number) => string;
};

const WORDS: Record<Language, Words> = {
  fr: {
    locale: 'fr-FR',
    year: 'Année',
    mileage: 'Kilométrage',
    fuel: 'Énergie',
    gearbox: 'Boîte',
    power: 'Puissance',
    hp: 'ch',
    surface: 'Surface',
    land: 'Terrain',
    rooms: 'Pièces',
    bedrooms: 'Chambres',
    floor: 'Étage',
    roomCount: (n) => `${n} pièce${n > 1 ? 's' : ''}`,
    bedroomCount: (n) => `${n} chambre${n > 1 ? 's' : ''}`,
  },
  de: {
    locale: 'de-DE',
    year: 'Baujahr',
    mileage: 'Kilometerstand',
    fuel: 'Kraftstoff',
    gearbox: 'Getriebe',
    power: 'Leistung',
    hp: 'PS',
    surface: 'Wohnfläche',
    land: 'Grundstück',
    rooms: 'Zimmer',
    bedrooms: 'Schlafzimmer',
    floor: 'Etage',
    roomCount: (n) => `${n} Zimmer`,
    bedroomCount: (n) => `${n} Schlafzimmer`,
  },
  it: {
    locale: 'it-IT',
    year: 'Anno',
    mileage: 'Chilometraggio',
    fuel: 'Alimentazione',
    gearbox: 'Cambio',
    power: 'Potenza',
    hp: 'CV',
    surface: 'Superficie',
    land: 'Terreno',
    rooms: 'Locali',
    bedrooms: 'Camere',
    floor: 'Piano',
    roomCount: (n) => `${n} local${n > 1 ? 'i' : 'e'}`,
    bedroomCount: (n) => `${n} camer${n > 1 ? 'e' : 'a'}`,
  },
  nl: {
    locale: 'nl-NL',
    year: 'Bouwjaar',
    mileage: 'Kilometerstand',
    fuel: 'Brandstof',
    gearbox: 'Transmissie',
    power: 'Vermogen',
    hp: 'pk',
    surface: 'Oppervlakte',
    land: 'Perceel',
    rooms: 'Kamers',
    bedrooms: 'Slaapkamers',
    floor: 'Verdieping',
    roomCount: (n) => `${n} kamer${n > 1 ? 's' : ''}`,
    bedroomCount: (n) => `${n} slaapkamer${n > 1 ? 's' : ''}`,
  },
};

/** Most specs shown: they must fit the 16:9 panel. */
export const MAX_SPECS = 5;

const same = (label: string, value: string): Spec => ({ label, value, chip: value });

/** The sheet's key facts in the video language, in the order of the vertical's template. */
export function sheetSpecs(sheet: Sheet, language: Language): Spec[] {
  const w = WORDS[language];
  const number = (n: number) => new Intl.NumberFormat(w.locale, { maximumFractionDigits: 10 }).format(n);
  const specs: Spec[] = [];
  if (sheet.vertical === 'auto') {
    if (sheet.year !== undefined) specs.push(same(w.year, String(sheet.year)));
    if (sheet.mileageKm !== undefined) specs.push(same(w.mileage, `${number(sheet.mileageKm)} km`));
    if (sheet.fuel) specs.push(same(w.fuel, sheet.fuel));
    if (sheet.gearbox) specs.push(same(w.gearbox, sheet.gearbox));
    if (sheet.powerHp !== undefined) specs.push(same(w.power, `${number(sheet.powerHp)} ${w.hp}`));
  } else {
    if (sheet.surfaceM2 !== undefined) specs.push(same(w.surface, `${number(sheet.surfaceM2)} m²`));
    if (sheet.rooms !== undefined) specs.push({ label: w.rooms, value: number(sheet.rooms), chip: w.roomCount(sheet.rooms) });
    if (sheet.bedrooms !== undefined) {
      specs.push({ label: w.bedrooms, value: number(sheet.bedrooms), chip: w.bedroomCount(sheet.bedrooms) });
    }
    if (sheet.landM2 !== undefined) {
      const land = `${number(sheet.landM2)} m²`;
      specs.push({ label: w.land, value: land, chip: `${w.land} ${land}` });
    }
    if (sheet.floor) specs.push({ label: w.floor, value: sheet.floor, chip: `${w.floor} ${sheet.floor}` });
  }
  return specs.slice(0, MAX_SPECS);
}
