import type { ProbePlatform } from './platforms';

export type Verdict = 'lisible' | 'partiel' | 'bloqué' | 'expirée' | 'erreur' | 'non testé';

export type Signal = {
  id: string;
  strength: 'strong' | 'weak';
  detail: string;
};

export type RawResponse = {
  status: number;
  headers: Record<string, string>;
  cookieNames: string[];
  body: string;
  bytes: number;
  truncated: boolean;
};

export type Analysis = {
  /**
   * The page title itself is not returned: a listing title can hold a phone number
   * or a name. Only whether it is a generic one (bare domain, block page) is kept.
   */
  genericTitle: boolean | null;
  visibleTextChars: number;
  embeddedData: string[];
  listingData: boolean;
  pageId: string | null;
  idMatches: boolean | null;
  price: { found: boolean; source: 'structured' | 'text' | null };
  photoCount: number;
  declaredPhotoCount: number | null;
  dpe: string | null;
  badTraffic: string | null;
  signals: Signal[];
  verdict: Verdict;
  reasons: string[];
  warnings: string[];
};

const BLOCK_STATUSES = new Set([401, 403, 407, 429, 451]);
const GONE_STATUSES = new Set([404, 410]);
/** DataDome interstitials come back as 2xx pages of about 1 KB. */
const INTERSTITIAL_MAX_BYTES = 5_000;

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * Undo the escapes that hide URLs, quotes and markers: JSON string escapes (also
 * doubly escaped, as in SeLoger's JSON.parse("...") blob), numeric and named
 * entities (Akamai block pages encode "#", "." and ":"), percent-encoded quotes.
 */
export function normalizeBody(body: string): string {
  return body
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/\\+"/g, '"')
    .replace(/\\+\//g, '/')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/%22/g, '"')
    .replace(/%3A/gi, ':')
    .replace(/%3D/gi, '=');
}

const GENERIC_TITLE =
  /^(?:(?:www\.)?[a-z0-9-]+\.(?:fr|com)|Just a moment\.\.\.|Access Denied|Attention Required! \| Cloudflare|ERROR: The request could not be satisfied)$/i;

export function extractTitle(body: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
  if (!m?.[1]) return null;
  const title = m[1].replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 150) : null;
}

export function visibleTextLength(body: string): number {
  return body
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

const EMBEDDED: ReadonlyArray<[string, RegExp]> = [
  ['__NEXT_DATA__', /<script[^>]*\bid=["']__NEXT_DATA__["']/i],
  ['next-rsc', /self\.__next_f\.push/],
  ['json-ld', /<script[^>]*type=["']application\/ld\+json["']/i],
  ['og', /<meta[^>]+property=["']og:(?:title|image|description)["']/i],
  ['seloger-state', /__UFRN_LIFECYCLE_SERVERREQUEST__/],
  ['lacentrale-vars', /CLASSIFIED_MAIN_INFOS|CLASSIFIED_GALLERY|SummaryInformationData/],
  ['initial-state', /__INITIAL_STATE__|__PRELOADED_STATE__|__APOLLO_STATE__/],
];

export function detectEmbeddedData(body: string): string[] {
  return EMBEDDED.filter(([, re]) => re.test(body)).map(([name]) => name);
}

export function countPhotos(normalized: string, platform: ProbePlatform, listingKey: string | null): number {
  const ids = new Set<string>();
  for (const m of normalized.matchAll(new RegExp(platform.photo.source, platform.photo.flags))) {
    const key = platform.photoKey(m, listingKey);
    if (key) ids.add(key.toLowerCase());
  }
  return ids.size;
}

export function findPrice(normalized: string, platform: ProbePlatform): Analysis['price'] {
  for (const { source, re } of platform.price) {
    if (re.test(normalized)) return { found: true, source };
  }
  return { found: false, source: null };
}

export function extractBadTraffic(normalized: string): string | null {
  const m = /\bbad_traffic"?\s*[:=]\s*["']?([a-z_-]+)/i.exec(normalized);
  return m?.[1]?.toLowerCase() ?? null;
}

function firstCapture(normalized: string, patterns: readonly RegExp[] | undefined): string | null {
  for (const re of patterns ?? []) {
    const value = re.exec(normalized)?.[1];
    if (value) return value;
  }
  return null;
}

function dataDomeDetail(body: string): string {
  const t = /'t'\s*:\s*'([a-z]+)'|[?&]t=(bv|fe)(?=[&'"\\]|$)/.exec(body);
  const kind = t?.[1] ?? t?.[2];
  const rt = /'rt'\s*:\s*'([a-z])'/.exec(body)?.[1];
  if (kind === 'bv') return 'DataDome : adresse IP bannie (t=bv), un captcha ne suffirait pas';
  if (kind === 'fe') return 'DataDome : captcha demandé (t=fe)';
  if (rt === 'i') return 'DataDome : interstitiel de vérification (rt=i)';
  return 'DataDome : page de captcha (captcha-delivery.com)';
}

/**
 * Anti-bot evidence on the normalized body. "strong" means the response itself is
 * a block or challenge page; "weak" means protection is present on the site (a JS
 * tag, a header, a cookie) without blocking. DataDome, Cloudflare and Akamai also
 * leave traces on normal pages, so weak signals never make a verdict "bloqué".
 */
export function detectSignals(raw: RawResponse, visibleChars: number): Signal[] {
  const { body, headers, cookieNames, status } = raw;
  const signals: Signal[] = [];
  const add = (id: string, strength: Signal['strength'], detail: string) =>
    signals.push({ id, strength, detail });
  const cookies = new Set(cookieNames.map((c) => c.toLowerCase()));
  const server = (headers['server'] ?? '').toLowerCase();

  // DataDome (Leboncoin, SeLoger, La Centrale)
  if (/captcha-delivery\.com/i.test(body) || /var\s*dd\s*=\s*\{/.test(body)) {
    add('datadome-challenge', 'strong', dataDomeDetail(body));
  } else if ('x-dd-b' in headers && (status < 200 || status >= 300)) {
    add('datadome-block', 'strong', `DataDome : réponse de blocage (x-dd-b, HTTP ${status})`);
  } else if ('x-dd-b' in headers) {
    add('datadome-flag', 'weak', 'DataDome : requête signalée (x-dd-b) mais page servie');
  } else if ('x-datadome' in headers || cookies.has('datadome')) {
    add('datadome-present', 'weak', 'DataDome actif sur le site, page servie');
  }

  // Cloudflare (PAP)
  if (
    headers['cf-mitigated'] === 'challenge' ||
    /window\._cf_chl_opt|\/cdn-cgi\/challenge-platform\/h\/|<title>\s*Just a moment\.\.\.\s*<\/title>|cf-browser-verification/i.test(body)
  ) {
    add('cloudflare-challenge', 'strong', 'Cloudflare : défi anti-robot');
  } else if (/Sorry, you have been blocked|Attention Required! \| Cloudflare|error code: 10(?:20|15)\b/i.test(body)) {
    add('cloudflare-block', 'strong', 'Cloudflare : accès refusé (WAF)');
  } else if ('cf-ray' in headers || cookies.has('__cf_bm') || /challenges\.cloudflare\.com/.test(body)) {
    add('cloudflare-present', 'weak', 'derrière Cloudflare');
  }

  // Akamai
  if (/<title>\s*Access Denied\s*<\/title>/i.test(body) && /Reference\s*#\s*\d+\.[0-9a-f.]+|errors\.edgesuite\.net/i.test(body)) {
    add('akamai-denied', 'strong', 'Akamai : Access Denied');
  } else if (/sec-if-cpt-container/.test(body)) {
    add('akamai-challenge', 'strong', 'Akamai Bot Manager : défi');
  } else if (cookies.has('_abck') || cookies.has('ak_bmsc') || cookies.has('bm_sz') || server.includes('akamaighost')) {
    add('akamai-present', 'weak', 'Akamai actif');
  }

  // AWS WAF (behind CloudFront): its CAPTCHA action answers HTTP 405
  if (/awswaf\.com|AwsWafIntegration|gokuProps/.test(body) || headers['x-amzn-waf-action'] !== undefined) {
    add('aws-waf-challenge', 'strong', 'AWS WAF : défi anti-robot');
  }

  // CloudFront (AutoScout24, La Centrale)
  if (/The request could not be satisfied|Generated by cloudfront \(CloudFront\)/i.test(body)) {
    add('cloudfront-error', 'strong', 'CloudFront : requête refusée');
  }

  // PerimeterX / HUMAN, Imperva
  if (/px-captcha|_pxCaptcha/i.test(body)) {
    add('perimeterx-challenge', 'strong', 'PerimeterX : captcha');
  }
  if ((/_Incapsula_Resource/i.test(body) && visibleChars < 500) || /Pardon Our Interruption/i.test(body)) {
    add('imperva-challenge', 'strong', 'Imperva : défi anti-robot');
  }

  if (BLOCK_STATUSES.has(status)) {
    add('http-status', 'strong', `HTTP ${status}`);
  }
  if (/captcha/i.test(body) && !signals.some((s) => s.strength === 'strong')) {
    add('captcha-word', 'weak', 'le mot « captcha » apparaît dans la page');
  }
  return signals;
}

export function analyze(platform: ProbePlatform, raw: RawResponse, url: URL): Analysis {
  const normalized = normalizeBody(raw.body);
  const listingKey = platform.listingKey?.(url) ?? null;
  const visibleTextChars = visibleTextLength(raw.body);
  const embeddedData = detectEmbeddedData(raw.body);
  const listingData = platform.listingData.test(normalized);
  const pageId = platform.pageId?.exec(normalized)?.[1] ?? null;
  const idMatches = listingKey && pageId ? pageId === listingKey : null;
  const price = findPrice(normalized, platform);
  const photoCount = countPhotos(normalized, platform, listingKey);
  const declared = platform.declaredPhotos?.exec(normalized)?.[1];
  const declaredPhotoCount = declared ? Number(declared) : null;
  const dpe = platform.vertical === 'immo' ? firstCapture(normalized, platform.dpe)?.toUpperCase() ?? null : null;
  const badTraffic = platform.reportsBadTraffic ? extractBadTraffic(normalized) : null;
  const signals = detectSignals({ ...raw, body: normalized }, visibleTextChars);

  const reasons: string[] = [];
  const warnings: string[] = [];
  const strong = signals.filter((s) => s.strength === 'strong');
  const ok = raw.status >= 200 && raw.status < 300;
  // A page id equal to the URL id is listing evidence too, whatever the page shape.
  const hasListing = listingData || idMatches === true;

  let verdict: Verdict;
  if (GONE_STATUSES.has(raw.status)) {
    verdict = 'expirée';
    reasons.push(`HTTP ${raw.status} : annonce expirée ou supprimée`);
  } else if (ok && platform.expired?.test(normalized)) {
    verdict = 'expirée';
    reasons.push('la page indique que l’annonce n’est plus disponible');
  } else if (ok && hasListing && idMatches !== false) {
    // The listing's own data wins over any marker: a served ad page is not a block page.
    if (price.found && photoCount > 0) {
      verdict = 'lisible';
      reasons.push(
        `données de l’annonce présentes, prix (${price.source === 'structured' ? 'données structurées' : 'texte'}), ${photoCount} photo(s)`,
      );
    } else {
      verdict = 'partiel';
      reasons.push('données de l’annonce présentes');
      if (!price.found) reasons.push('prix introuvable');
      if (photoCount === 0) reasons.push('aucune URL de photo reconnue');
    }
  } else if (strong.length > 0) {
    verdict = 'bloqué';
    reasons.push(...strong.map((s) => s.detail));
  } else if (!ok && signals.some((s) => s.id === 'captcha-word')) {
    verdict = 'bloqué';
    reasons.push(`HTTP ${raw.status} avec une page de captcha`);
  } else if (!ok) {
    verdict = 'erreur';
    reasons.push(`HTTP ${raw.status} inattendu`);
  } else if (hasListing && idMatches === false) {
    verdict = 'partiel';
    reasons.push(`la page servie est l’annonce ${pageId}, pas ${listingKey}`);
  } else if (raw.bytes < INTERSTITIAL_MAX_BYTES || visibleTextChars < 200) {
    verdict = 'bloqué';
    reasons.push(`page de ${raw.bytes} octets sans données d’annonce (interstitiel ou blocage silencieux)`);
  } else {
    verdict = 'partiel';
    reasons.push('aucune donnée d’annonce reconnue : mise en page inconnue ou page d’un autre type');
    if (price.found) reasons.push('un prix apparaît');
    if (photoCount > 0) reasons.push(`${photoCount} photo(s) reconnue(s)`);
  }

  if (verdict === 'lisible' && price.source === 'text') {
    warnings.push('prix trouvé seulement dans le texte : à confirmer');
  }
  if ((verdict === 'lisible' || verdict === 'partiel') && declaredPhotoCount !== null && declaredPhotoCount !== photoCount) {
    warnings.push(`${photoCount} photo(s) reconnue(s) pour ${declaredPhotoCount} annoncée(s) par la page`);
  }
  if (badTraffic && badTraffic !== 'ok') {
    warnings.push(`bad_traffic=${badTraffic} : le site classe ce serveur comme non humain`);
  }
  if (platform.reportsBadTraffic && badTraffic === null && ok && listingData) {
    warnings.push('champ bad_traffic absent de la page');
  }
  if (platform.vertical === 'immo' && dpe === null && (verdict === 'lisible' || verdict === 'partiel')) {
    warnings.push('classe DPE non trouvée');
  }
  if (raw.truncated) {
    warnings.push(`page tronquée à ${raw.bytes} octets pour l’analyse`);
  }
  if (verdict !== 'bloqué') {
    for (const s of signals) if (s.strength === 'weak') warnings.push(s.detail);
  }

  const title = extractTitle(raw.body);
  return {
    genericTitle: title === null ? null : GENERIC_TITLE.test(title),
    visibleTextChars,
    embeddedData,
    listingData,
    pageId,
    idMatches,
    price,
    photoCount,
    declaredPhotoCount,
    dpe,
    badTraffic,
    signals,
    verdict,
    reasons,
    warnings,
  };
}
