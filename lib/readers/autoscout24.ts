import { detectSignals, normalizeBody, visibleTextLength } from '../probe/analyze';
import { DEFAULT_USER_AGENT, requestHeaders } from '../probe/fetch';
import { matchPlatform } from '../probe/platforms';
import { parseSheet, type Photo, type VehicleSheet } from '../sheet';
import { ReadError, type ReadFailureReason } from './errors';

/**
 * AutoScout24.fr, read by the server (step 0: the page is served to Vercel).
 * One GET of one listing page, never a search page (rule 1). The data comes from
 * the Next.js blob (__NEXT_DATA__, props.pageProps.listingDetails); the HTML is only
 * held in memory while it is parsed, never kept or logged (rule 2). Only what the
 * listing states goes into the sheet: an absent field stays absent (rule 3).
 *
 * The shape of listingDetails comes from public scrapers (2026), not from a real page
 * read here: every field is optional and checked before use.
 */

export const PLATFORM = 'autoscout24-fr';

const TIMEOUT_MS = 20_000;
/** Redirects followed when they stay on the same listing (www host, slash, slug). */
const MAX_REDIRECTS = 2;
const PHOTO_SIZE = '1920x1080';
const PHOTO =
  /^https:\/\/prod\.pictures\.autoscout24\.net\/listing-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f-]{8,})\.(jpe?g|png|webp)(?:\/\d+x\d+\.(?:webp|jpe?g|png))?$/i;
const LISTING_UUID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
/** adTargetingString "gear" code. Other codes are not documented: left out. */
const GEARBOX: Record<string, string> = { M: 'Manuelle', A: 'Automatique' };

export type ReadDeps = { fetch: typeof globalThis.fetch };

export type FetchedPage = { status: number; headers: Headers; body: string };

type Json = Record<string, unknown>;

function fail(reason: ReadFailureReason, message: string): never {
  throw new ReadError(PLATFORM, reason, `AutoScout24 : ${message}`);
}

function toUrl(input: string): URL | null {
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

/** The listing itself: no query string, no fragment. Null if the URL is not a listing. */
function listingUrl(input: string): URL | null {
  const url = toUrl(input);
  if (!url || matchPlatform(url)?.id !== PLATFORM) return null;
  url.search = '';
  url.hash = '';
  return url;
}

export function canHandle(url: string): boolean {
  return listingUrl(url) !== null;
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

/**
 * A { raw, formatted } pair or a plain string: the formatted label is the one shown on
 * the page. A single character ("B", "M") is a code, not a label: left out.
 */
function label(value: unknown): string | undefined {
  const s = text(obj(value)?.formatted) ?? text(value);
  return s !== undefined && s.length > 1 ? s : undefined;
}

/** A whole number (0 included), given as a number or as a string of digits. */
function wholeNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Drops undefined fields: an absent fact is absent from the sheet, not set to undefined. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Page

/** props.pageProps.listingDetails of the Next.js blob, or null. */
export function extractListingDetails(html: string): Json | null {
  const m = /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m?.[1]) return null;
  try {
    const data: unknown = JSON.parse(m[1]);
    return obj(obj(obj(obj(data)?.props)?.pageProps)?.listingDetails) ?? null;
  } catch {
    return null;
  }
}

function blockReasons(page: FetchedPage): string[] {
  const normalized = normalizeBody(page.body);
  const headers: Record<string, string> = {};
  page.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const cookieNames = page.headers.getSetCookie().map((c) => c.split('=', 1)[0]?.trim() ?? '');
  const raw = { status: page.status, headers, cookieNames, body: normalized, bytes: page.body.length, truncated: false };
  return detectSignals(raw, visibleTextLength(page.body))
    .filter((s) => s.strength === 'strong')
    .map((s) => s.detail);
}

/**
 * Sheet of a fetched listing page. Refuses redirects (read has already followed those
 * that stay on the listing), removed listings, block pages
 * and pages without the listing's data. The listing's own data wins over anti-bot
 * markers: AutoScout24 serves real pages that still carry protection scripts.
 */
export function parsePage(page: FetchedPage, sourceUrl: string): VehicleSheet {
  const { status } = page;
  if (status >= 300 && status < 400) {
    fail('expired', `la page redirige ailleurs (HTTP ${status}) : l’annonce a sans doute été retirée.`);
  }
  if (status === 404 || status === 410) {
    fail('expired', `l’annonce n’existe plus (HTTP ${status}).`);
  }
  const ok = status >= 200 && status < 300;
  const details = ok ? extractListingDetails(page.body) : null;
  if (!details) {
    const reasons = blockReasons(page);
    if (reasons.length > 0) {
      fail('anti-bot', `le site a refusé la lecture (${reasons.join(' ; ')}). Utilisez le formulaire de secours.`);
    }
    if (!ok) fail('http', `réponse HTTP ${status} inattendue.`);
    fail('no-data', 'les données de l’annonce sont absentes de la page (bloc __NEXT_DATA__ introuvable ou modifié).');
  }
  return mapListing(details, sourceUrl);
}

/**
 * Target of a redirect that stays on the same listing (host without www, trailing
 * slash, renamed slug), or null: any other redirect is a removed listing.
 */
function sameListingRedirect(location: string | null, from: URL): URL | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return null;
  }
  const next = listingUrl(target.href);
  const uuid = (u: URL) => LISTING_UUID.exec(u.pathname)?.[1]?.toLowerCase();
  return next && uuid(next) === uuid(from) && next.href !== from.href ? next : null;
}

/**
 * One GET of the listing, then parsePage. A redirect is followed only while it stays
 * on the same listing (at most MAX_REDIRECTS); any other one is left to parsePage.
 */
export async function read(url: string, deps: ReadDeps = { fetch: globalThis.fetch }): Promise<VehicleSheet> {
  const listing = listingUrl(url);
  if (!listing) {
    fail('unsupported', 'ce lien n’est pas celui d’une annonce autoscout24.fr (/offres/…).');
  }
  let current: URL = listing;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let page: FetchedPage;
  try {
    for (let hop = 0; ; hop++) {
      const res = await deps.fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: requestHeaders(DEFAULT_USER_AGENT),
        signal,
      });
      const next: URL | null =
        res.status >= 300 && res.status < 400 && hop < MAX_REDIRECTS
          ? sameListingRedirect(res.headers.get('location'), current)
          : null;
      if (next) {
        await res.body?.cancel();
        current = next;
        continue;
      }
      page = { status: res.status, headers: res.headers, body: await res.text() };
      break;
    }
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    fail('network', timeout ? `la page n’a pas répondu en ${TIMEOUT_MS / 1000} s.` : 'la page n’a pas pu être chargée (erreur réseau).');
  }
  return parsePage(page, current.href);
}

// ---------------------------------------------------------------------------
// Mapping

/** "gear", "sthp"… of the tracking block, a JSON object serialized as a string. */
function parseTargeting(value: unknown): Json {
  if (typeof value !== 'string') return obj(value) ?? {};
  try {
    return obj(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

/**
 * One URL per photo, at the largest size the host serves, in listing order. Photos
 * of other listings (similar ads) are dropped when the listing id is known.
 */
export function normalizePhotos(images: unknown, listingId: string | null): Photo[] {
  if (!Array.isArray(images)) return [];
  const seen = new Set<string>();
  const photos: Photo[] = [];
  for (const image of images) {
    const m = typeof image === 'string' ? PHOTO.exec(image.trim()) : null;
    if (!m) continue;
    const [, listing = '', photoId = '', ext = ''] = m;
    if (listingId && listing.toLowerCase() !== listingId) continue;
    const key = `${listing}_${photoId}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    photos.push({ url: `https://prod.pictures.autoscout24.net/listing-images/${listing}_${photoId}.${ext}/${PHOTO_SIZE}.webp` });
  }
  return photos;
}

/** Equipment grouped by category (arrays of { id, name } or strings), flattened to labels. */
export function flattenEquipment(equipment: unknown): string[] {
  const groups = Array.isArray(equipment) ? [equipment] : Object.values(obj(equipment) ?? {});
  const labels = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const name = text(item) ?? text(obj(item)?.name);
      if (name) labels.add(name);
    }
  }
  return [...labels];
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', deg: '°', sup2: '²',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—',
  middot: '·', bull: '•', times: '×', oelig: 'œ', OElig: 'Œ',
  agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ugrave: 'Ù',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,7});/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code] ?? entity;
  });
}

/** Plain text of an HTML description: one line per paragraph or list item, tags dropped, entities decoded. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|ul|ol|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(withBreaks)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n\s*/g, '\n')
    .trim();
}

/** "Peugeot 3008 Hybrid 145 e-DCS6 GT", without repeating the model when the version starts with it. */
function buildTitle(make: string, model: string, version: string | undefined): string {
  if (!version) return `${make} ${model}`;
  const lower = version.toLowerCase();
  if (lower.startsWith(`${make} ${model}`.toLowerCase())) return version;
  if (lower.startsWith(model.toLowerCase())) return `${make} ${version}`;
  return `${make} ${model} ${version}`;
}

function sellerType(seller: Json | undefined): VehicleSheet['sellerType'] {
  if (typeof seller?.isDealer === 'boolean') return seller.isDealer ? 'pro' : 'particulier';
  const type = text(seller?.type);
  if (type && /dealer/i.test(type)) return 'pro';
  if (type && /private/i.test(type)) return 'particulier';
  fail('missing-field', 'type de vendeur (professionnel ou particulier) absent de l’annonce.');
}

function firstPhone(phones: unknown): string | undefined {
  if (!Array.isArray(phones)) return undefined;
  for (const phone of phones) {
    const number = text(phone) ?? text(obj(phone)?.formattedNumber) ?? text(obj(phone)?.callTo);
    if (number) return number;
  }
  return undefined;
}

/** VehicleSheet from props.pageProps.listingDetails, validated by parseSheet. */
export function mapListing(details: Json, sourceUrl: string): VehicleSheet {
  const listingId = LISTING_UUID.exec(new URL(sourceUrl).pathname)?.[1]?.toLowerCase() ?? null;
  const pageId = text(details.id)?.toLowerCase();
  if (listingId && pageId && pageId !== listingId) {
    fail('wrong-listing', 'la page servie est celle d’une autre annonce que le lien demandé.');
  }

  const vehicle = obj(details.vehicle) ?? {};
  // The tracking block is a fallback for power and gearbox only: whether its stmak and
  // stmod are labels or ids is not known, so they never name the vehicle.
  const targeting = parseTargeting(details.adTargetingString);
  const make = text(vehicle.make);
  const model = text(vehicle.model);
  if (!make || !model) fail('missing-field', 'marque ou modèle absent des données de l’annonce.');
  const version = text(vehicle.modelVersionInput);

  const prices = obj(details.prices);
  const location = obj(details.location);
  const seller = obj(details.seller);
  const type = sellerType(seller);
  const year = Number(/^(\d{4})-\d{2}-\d{2}/.exec(text(vehicle.firstRegistrationDateRaw) ?? '')?.[1]);
  const description = typeof details.description === 'string' ? htmlToText(details.description) : '';
  const gear = text(targeting.gear)?.toUpperCase();

  const sheet = validate(
    defined({
      vertical: 'auto',
      platform: PLATFORM,
      sourceUrl,
      title: buildTitle(make, model, version),
      make,
      model,
      version,
      year: year >= 1900 && year <= 2100 ? year : undefined,
      mileageKm: wholeNumber(vehicle.mileageInKmRaw),
      fuel: label(vehicle.fuelCategory),
      gearbox: label(vehicle.transmissionType) ?? (gear ? GEARBOX[gear] : undefined),
      // Horsepower as stated; never converted from kW (a rounded figure could differ from the listing).
      powerHp: wholeNumber(vehicle.rawPowerInHp) || wholeNumber(targeting.sthp) || undefined,
      price: positiveNumber(obj(prices?.public)?.priceRaw) ?? positiveNumber(obj(prices?.dealer)?.priceRaw),
      currency: 'EUR',
      city: text(location?.city),
      postalCode: text(location?.zip),
      phone: firstPhone(seller?.phones),
      sellerType: type,
      sellerName: text(seller?.companyName) ?? text(seller?.contactName),
      equipment: flattenEquipment(vehicle.equipment),
      description: description || undefined,
      photos: normalizePhotos(details.images, listingId),
    } satisfies Partial<VehicleSheet>),
  );
  if (sheet.vertical !== 'auto') fail('invalid-input', 'fiche inattendue.');
  return sheet;
}

function validate(candidate: object) {
  try {
    return parseSheet(candidate);
  } catch (err) {
    fail('missing-field', err instanceof Error ? err.message : String(err));
  }
}
