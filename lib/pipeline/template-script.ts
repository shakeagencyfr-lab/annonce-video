import type { PropertySheet, Sheet, VehicleSheet } from '../sheet';
import type { Language, ScriptSegment, Variant, VideoScript } from './types';

/**
 * Scripts built from a fixed French template, without Claude: used by the offline
 * mode (no API key) to test the whole pipeline. Every sentence comes from a sheet
 * field that is present, so nothing is invented (rule 3).
 */

const NBSP = ' ';

/** French format, as written in the sheet: 68 000, 64,7 (never rounded). */
export function formatNumber(n: number): string {
  const [int = '', dec] = String(n).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return dec ? `${grouped},${dec}` : grouped;
}

export function formatPrice(price: number, currency: 'EUR' | 'CHF'): string {
  return currency === 'EUR' ? `${formatNumber(price)}${NBSP}€` : `CHF${NBSP}${formatNumber(price)}`;
}

function segment(kind: ScriptSegment['kind'], text: string, facts: string[]): ScriptSegment {
  return { kind, text, facts };
}

function contactLine(name: string | undefined, city: string | undefined, phone: string | undefined): string | undefined {
  const parts = [name, city, phone].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function vehicleScript(sheet: VehicleSheet, variant: Variant): VideoScript {
  const segments: ScriptSegment[] = [];
  const name = `${sheet.make} ${sheet.model}`;
  segments.push(
    sheet.year
      ? segment('hook', `${name} de ${sheet.year}.`, ['make', 'model', 'year'])
      : segment('hook', `${name}.`, ['make', 'model']),
  );
  if (sheet.mileageKm !== undefined) {
    segments.push(segment('point', `${formatNumber(sheet.mileageKm)} kilomètres au compteur.`, ['mileageKm']));
  }
  const drive = [sheet.fuel, sheet.gearbox?.toLowerCase(), sheet.powerHp ? `${sheet.powerHp} chevaux` : undefined].filter(Boolean);
  if (drive.length > 0) {
    const facts = [sheet.fuel && 'fuel', sheet.gearbox && 'gearbox', sheet.powerHp && 'powerHp'].filter((f): f is string => Boolean(f));
    segments.push(segment('point', `${drive.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()), facts));
  }
  const equipment = sheet.equipment.slice(0, 3);
  if (equipment.length > 0) {
    segments.push(
      segment('point', `Équipée : ${equipment.join(', ')}.`, equipment.map((_, i) => `equipment[${i}]`)),
    );
  }
  if (sheet.warranty) segments.push(segment('point', `${sheet.warranty}.`, ['warranty']));
  if (variant === 'social' && sheet.price !== undefined) {
    segments.push(segment('point', `Prix : ${formatPrice(sheet.price, sheet.currency)}.`, ['price']));
  }
  segments.push(
    variant === 'social' && sheet.sellerName
      ? segment('cta', `Contactez ${sheet.sellerName}.`, ['sellerName'])
      : segment('cta', 'Tous les détails sont dans l’annonce.', []),
  );

  const subtitle = [sheet.year, sheet.mileageKm !== undefined ? `${formatNumber(sheet.mileageKm)} km` : undefined, sheet.fuel]
    .filter(Boolean)
    .join(' · ');
  return {
    variant,
    language: 'fr',
    segments,
    overlays: {
      title: name,
      ...(subtitle ? { subtitle } : {}),
      ...(variant === 'social' && sheet.price !== undefined ? { price: formatPrice(sheet.price, sheet.currency) } : {}),
      ...(variant === 'social' ? optional('contact', contactLine(sheet.sellerName, sheet.city, sheet.phone)) : {}),
    },
  };
}

function propertyScript(sheet: PropertySheet, variant: Variant): VideoScript {
  const segments: ScriptSegment[] = [];
  const where = sheet.district ?? sheet.city;
  segments.push(
    segment(
      'hook',
      `${sheet.propertyType}${where ? ` à ${where}` : ''}.`,
      ['propertyType', ...(sheet.district ? ['district'] : sheet.city ? ['city'] : [])],
    ),
  );
  const size = [
    sheet.surfaceM2 !== undefined ? `${formatNumber(sheet.surfaceM2)} m²` : undefined,
    sheet.rooms !== undefined ? `${sheet.rooms} pièces` : undefined,
    sheet.bedrooms !== undefined ? `${sheet.bedrooms} chambres` : undefined,
  ].filter(Boolean);
  if (size.length > 0) {
    const facts = [sheet.surfaceM2 !== undefined && 'surfaceM2', sheet.rooms !== undefined && 'rooms', sheet.bedrooms !== undefined && 'bedrooms'];
    segments.push(segment('point', `${size.join(', ')}.`, facts.filter((f): f is string => Boolean(f))));
  }
  const features = sheet.features.slice(0, 3);
  if (features.length > 0) {
    segments.push(segment('point', `${features.join(', ')}.`, features.map((_, i) => `features[${i}]`)));
  }
  if (variant === 'social' && sheet.price !== undefined) {
    segments.push(segment('point', `Prix : ${formatPrice(sheet.price, sheet.currency)}.`, ['price']));
  }
  segments.push(
    variant === 'social' && sheet.agencyName
      ? segment('cta', `Contactez ${sheet.agencyName}.`, ['agencyName'])
      : segment('cta', 'Tous les détails sont dans l’annonce.', []),
  );
  const subtitle = size.join(' · ');
  return {
    variant,
    language: 'fr',
    segments,
    overlays: {
      title: sheet.propertyType,
      ...(subtitle ? { subtitle } : {}),
      ...(variant === 'social' && sheet.price !== undefined ? { price: formatPrice(sheet.price, sheet.currency) } : {}),
      ...(variant === 'social' ? optional('contact', contactLine(sheet.agencyName, sheet.city, sheet.phone)) : {}),
    },
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

export function templateScripts(sheet: Sheet, language: Language): Record<Variant, VideoScript> {
  if (language !== 'fr') throw new Error(`Le mode hors ligne n'a de modèle qu'en français (demandé : ${language})`);
  const build = (variant: Variant) => (sheet.vertical === 'auto' ? vehicleScript(sheet, variant) : propertyScript(sheet, variant));
  return { social: build('social'), listing: build('listing') };
}
