import { z } from 'zod';
import { getPlatform, matchPlatform } from '../probe/platforms';
import { parseSheet, type Photo, type PropertySheet, type Sheet, type VehicleSheet } from '../sheet';
import { ReadError, type ReadFailureReason } from './errors';

/**
 * Leboncoin. Its pages are behind DataDome and refused to our servers (step 0), so
 * the server never fetches them: the seller exports the listing displayed in their own
 * browser with the bookmarklet (tools/leboncoin-export.js, `npm run bookmarklet`),
 * and the export is mapped here. One listing, on the seller's action (rule 1).
 *
 * The ad object is props.pageProps.ad of the page's __NEXT_DATA__. Its shape comes
 * from public fixtures (2025-2026), not from a page read here: every field is checked.
 */

export const PLATFORM = 'leboncoin';
export const EXPORT_SOURCE = 'leboncoin';
export const EXPORT_VERSION = 1;

type Category =
  | { slug: 'voitures'; vertical: 'auto' }
  | { slug: 'ventes_immobilieres' | 'locations'; vertical: 'immo'; transaction: PropertySheet['transaction'] };

/** category_id -> category. Other categories (motos, vacances…) are not supported. */
const CATEGORIES: Record<string, Category> = {
  '2': { slug: 'voitures', vertical: 'auto' },
  '9': { slug: 'ventes_immobilieres', vertical: 'immo', transaction: 'vente' },
  '10': { slug: 'locations', vertical: 'immo', transaction: 'location' },
};

const HOSTS = getPlatform('leboncoin-auto')?.hosts ?? ['www.leboncoin.fr', 'leboncoin.fr'];
const AD_PATH = /^\/ad\/([a-z_]+)\/(\d+)\/?$/;
/** Photos are downloaded by our server later: only this host and path are accepted. */
const PHOTO_HOST = 'img.leboncoin.fr';
const PHOTO_PATH = /^\/api\/v1\/lbcpb1\/images\/[0-9a-z/]+\.jpg$/i;

type Json = Record<string, unknown>;

function fail(reason: ReadFailureReason, message: string): never {
  throw new ReadError(PLATFORM, reason, `Leboncoin : ${message}`);
}

function toUrl(input: string): URL | null {
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

/** Category slug and id of a single-ad URL (never a search page, rule 1), or null. */
export function adRef(url: URL): { slug: string; id: string } | null {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (!HOSTS.includes(url.hostname.toLowerCase())) return null;
  const m = AD_PATH.exec(url.pathname);
  return m?.[1] && m[2] ? { slug: m[1], id: m[2] } : null;
}

export function canHandle(url: string): boolean {
  const parsed = toUrl(url);
  if (!parsed) return false;
  const platform = matchPlatform(parsed)?.id;
  // Rentals are not in the step 0 probe list but are read the same way.
  return platform === 'leboncoin-auto' || platform === 'leboncoin-immo' || adRef(parsed)?.slug === 'locations';
}

export const BOOKMARKLET_HELP =
  'Leboncoin bloque la lecture des annonces par nos serveurs (protection anti-robot DataDome). ' +
  'Exportez l’annonce depuis votre navigateur : installez le favori d’export (npm run bookmarklet), ' +
  'ouvrez la page de l’annonce sur leboncoin.fr, cliquez sur le favori, puis lancez ' +
  'npm run make-video -- <fichier leboncoin-….json téléchargé>.';

/** Never fetches: Leboncoin refuses server reads (step 0). Always throws, with the way out. */
export async function read(url: string): Promise<Sheet> {
  if (!canHandle(url)) fail('unsupported', 'ce lien n’est pas celui d’une annonce.');
  throw new ReadError(PLATFORM, 'server-read-blocked', BOOKMARKLET_HELP);
}

// ---------------------------------------------------------------------------
// Export envelope

const EnvelopeSchema = z.object({
  source: z.literal(EXPORT_SOURCE),
  version: z.literal(EXPORT_VERSION),
  url: z.string().url(),
  exportedAt: z.iso.datetime({ offset: true }),
  ad: z.looseObject({
    list_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
    category_id: z.union([z.string(), z.number().int()]),
  }),
});

export type LeboncoinExport = z.infer<typeof EnvelopeSchema>;

/** Looks like a Leboncoin export (to route a file); fromExport validates it. */
export function isExport(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as Json).source === EXPORT_SOURCE;
}

/**
 * Sheet of an export made by the bookmarklet. The envelope is checked (source,
 * version, a single-ad URL whose id and category match the ad) so a file edited by
 * hand or made for another listing is refused.
 */
export function fromExport(json: unknown): Sheet {
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`);
    fail('invalid-input', `fichier d’export invalide (${issues.join(' ; ')}). Refaites l’export depuis la page de l’annonce.`);
  }
  const { url, ad } = parsed.data;
  const ref = adRef(new URL(url));
  if (!ref) fail('invalid-input', 'l’adresse de l’export n’est pas celle d’une annonce leboncoin.fr.');
  if (ref.id !== String(ad.list_id)) {
    fail('wrong-listing', `l’export contient l’annonce ${ad.list_id}, pas celle de son adresse (${ref.id}).`);
  }
  const category = CATEGORIES[String(ad.category_id)];
  if (!category) {
    fail('unsupported', `catégorie ${ad.category_id} non prise en charge : seules les voitures et l’immobilier (vente, location) le sont.`);
  }
  if (category.slug !== ref.slug) {
    fail('wrong-listing', `la catégorie de l’annonce (${category.slug}) ne correspond pas à son adresse (${ref.slug}).`);
  }
  const sourceUrl = `https://www.leboncoin.fr/ad/${ref.slug}/${ref.id}`;
  return category.vertical === 'auto' ? mapVehicle(ad, sourceUrl) : mapProperty(ad, sourceUrl, category.transaction);
}

// ---------------------------------------------------------------------------
// Typed access to untrusted JSON

function obj(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((v): v is string => v !== undefined) : [];
}

/** "68000", "68 000" or 68000 -> 68000. */
function wholeNumber(value: unknown): number | undefined {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.replace(/[\s  ]/g, '') : '';
  return /^\d+$/.test(s) ? Number(s) : undefined;
}

/** "65", "65,5" or 65.5 -> 65.5. */
function decimal(value: unknown): number | undefined {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(',', '.') : '';
  return /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : undefined;
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && n > 0 ? n : undefined;
}

/** Drops undefined fields: an absent fact is absent from the sheet, not set to undefined. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

type Attribute = { value?: string; label?: string; values: string[]; labels: string[] };

/** attributes[] by key: { key, value, value_label, values, values_label }. */
function attributes(ad: Json): Map<string, Attribute> {
  const map = new Map<string, Attribute>();
  if (!Array.isArray(ad.attributes)) return map;
  for (const item of ad.attributes) {
    const a = obj(item);
    const key = text(a?.key);
    if (!a || !key || map.has(key)) continue;
    map.set(key, {
      value: text(a.value),
      label: text(a.value_label),
      values: texts(a.values),
      labels: texts(a.values_label),
    });
  }
  return map;
}

function price(ad: Json): number | undefined {
  const euros = Array.isArray(ad.price) ? ad.price[0] : ad.price;
  if (typeof euros === 'number' && euros > 0) return euros;
  const cents = ad.price_cents;
  return typeof cents === 'number' && cents > 0 ? cents / 100 : undefined;
}

/** Large photos first (?rule=ad-large); only Leboncoin image URLs, deduplicated, in listing order. */
export function adPhotos(ad: Json): Photo[] {
  const images = obj(ad.images);
  const large = texts(images?.urls_large);
  const urls = large.length > 0 ? large : texts(images?.urls);
  const seen = new Set<string>();
  const photos: Photo[] = [];
  for (const raw of urls) {
    const url = toUrl(raw);
    // Image ids are not always hex (some start with "gh"): the path is not checked further.
    if (!url || url.protocol !== 'https:' || url.hostname !== PHOTO_HOST || url.port !== '' || !PHOTO_PATH.test(url.pathname)) continue;
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    photos.push({ url: url.href });
  }
  return photos;
}

function place(ad: Json) {
  const location = obj(ad.location);
  return { city: text(location?.city), postalCode: text(location?.zipcode) };
}

function owner(ad: Json): { pro: boolean; name?: string; siren?: string } {
  const o = obj(ad.owner);
  const type = text(o?.type);
  if (type !== 'pro' && type !== 'private') fail('missing-field', 'type de vendeur (pro ou particulier) absent de l’annonce.');
  const siren = text(o?.siren)?.replace(/\s/g, '');
  return { pro: type === 'pro', name: text(o?.name), siren: siren && /^\d{9}$/.test(siren) ? siren : undefined };
}

/**
 * The name buyers see: a pro's shop name ("store_name", which also signs the ad), else
 * the account name (often the legal entity, e.g. "RS AUTOMOBILES" for "VOGUE AUTOMOBILES").
 */
function displayedSeller(attrs: Map<string, Attribute>, accountName: string | undefined): string | undefined {
  const store = attrs.get('store_name');
  return store?.label ?? store?.value ?? accountName;
}

const BULLET = /^\s*[-•*–]\s+(.+?)\s*$/;

/**
 * Items the seller listed as bullet points in the description ("- Radar de stationnement
 * AR"), copied as written: many pro ads put their equipment there instead of in
 * vehicle_specifications. Nothing is inferred from free text (rule 3).
 */
export function descriptionBullets(body: string | undefined, max = 150): string[] {
  if (!body) return [];
  const items = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const item = BULLET.exec(line)?.[1]?.replace(/\s+/g, ' ');
    if (!item || item.length < 2 || item.length > 80) continue;
    const key = item.toLowerCase();
    if (!items.has(key)) items.set(key, item);
    if (items.size >= max) break;
  }
  return [...items.values()];
}

function validate(candidate: object): Sheet {
  try {
    return parseSheet(candidate);
  } catch (err) {
    fail('missing-field', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Vertical mappings

/** "1.2 PureTech 130ch S&S BVM6" + "Allure", without repeating the trim level. */
function joinVersion(version: string | undefined, trim: string | undefined): string | undefined {
  if (!version || !trim) return version ?? trim;
  return version.toLowerCase().includes(trim.toLowerCase()) ? version : `${version} ${trim}`;
}

function year(attrs: Map<string, Attribute>): number | undefined {
  const fromRegdate = wholeNumber(attrs.get('regdate')?.value);
  // issuance_date: first registration, "MM/YYYY".
  const fromIssuance = wholeNumber(/(\d{4})$/.exec(attrs.get('issuance_date')?.value ?? '')?.[1]);
  const y = fromRegdate ?? fromIssuance;
  return y !== undefined && y >= 1900 && y <= 2100 ? y : undefined;
}

function equipmentOf(attrs: Map<string, Attribute>, body: string | undefined): string[] {
  const listed = [...new Set(attrs.get('vehicle_specifications')?.labels ?? [])];
  return listed.length > 0 ? listed : descriptionBullets(body);
}

function mapVehicle(ad: Json, sourceUrl: string): VehicleSheet {
  const attrs = attributes(ad);
  // Labels are what the page shows; values can be codes ("1") or keys ("PEUGEOT", "Peugeot_308").
  // Every label is tried before any value.
  const labelOf = (key: string) => attrs.get(key)?.label;
  const valueOf = (key: string) => attrs.get(key)?.value;
  const named = (key: string) => labelOf(key) ?? valueOf(key);
  const seller = owner(ad);
  const sheet = validate(
    defined({
      vertical: 'auto',
      platform: PLATFORM,
      sourceUrl,
      title: text(ad.subject),
      make: labelOf('brand') ?? labelOf('u_car_brand') ?? valueOf('brand') ?? valueOf('u_car_brand'),
      // Never the value of u_car_model: a key such as "Peugeot_308", not the model's name.
      model: labelOf('model') ?? labelOf('u_car_model') ?? valueOf('model'),
      version: joinVersion(named('u_car_version'), named('u_car_finition')),
      year: year(attrs),
      mileageKm: wholeNumber(attrs.get('mileage')?.value),
      fuel: labelOf('fuel'),
      gearbox: labelOf('gearbox'),
      // DIN horsepower only: "horsepower" is the fiscal rating (CV fiscaux), not the power.
      powerHp: positive(wholeNumber(attrs.get('horse_power_din')?.value)),
      price: price(ad),
      currency: 'EUR',
      // No phone: it is not in the ad JSON (shown on demand), so it stays absent.
      ...place(ad),
      sellerType: seller.pro ? 'pro' : 'particulier',
      sellerName: seller.pro ? displayedSeller(attrs, seller.name) : seller.name,
      sellerSiren: seller.siren,
      warranty: labelOf('ad_warranty_type'),
      equipment: equipmentOf(attrs, text(ad.body)),
      description: text(ad.body),
      photos: adPhotos(ad),
    } satisfies Partial<VehicleSheet>),
  );
  if (sheet.vertical !== 'auto') fail('invalid-input', 'fiche inattendue.');
  return sheet;
}

/** "a" to "g" (value or label). "v" (vierge), "Non renseigné" and anything else: absent. */
function energyClass(attr: Attribute | undefined): PropertySheet['dpe'] {
  const letter = [attr?.value, attr?.label].find((v) => v !== undefined && /^[a-g]$/i.test(v));
  return letter?.toUpperCase() as PropertySheet['dpe'];
}

function mapProperty(ad: Json, sourceUrl: string, transaction: PropertySheet['transaction']): PropertySheet {
  const attrs = attributes(ad);
  const seller = owner(ad);
  const floor = attrs.get('floor_number');
  const sheet = validate(
    defined({
      vertical: 'immo',
      platform: PLATFORM,
      sourceUrl,
      transaction,
      propertyType: attrs.get('real_estate_type')?.label,
      price: price(ad),
      currency: 'EUR',
      surfaceM2: positive(decimal(attrs.get('square')?.value)),
      landM2: positive(decimal(attrs.get('land_plot_surface')?.value)),
      rooms: positive(wholeNumber(attrs.get('rooms')?.value)),
      bedrooms: wholeNumber(attrs.get('bedrooms')?.value),
      floor: floor?.label ?? floor?.value,
      ...place(ad),
      dpe: energyClass(attrs.get('energy_rate')),
      ges: energyClass(attrs.get('ges')),
      // No documented feature attribute: the seller's own bullet list, if any, as written.
      features: descriptionBullets(text(ad.body)),
      description: text(ad.body),
      agencyName: seller.pro ? displayedSeller(attrs, seller.name) : undefined,
      photos: adPhotos(ad),
    } satisfies Partial<PropertySheet>),
  );
  if (sheet.vertical !== 'immo') fail('invalid-input', 'fiche inattendue.');
  return sheet;
}
