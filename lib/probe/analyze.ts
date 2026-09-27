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
  title: string | null;
  visibleTextChars: number;
  embeddedData: string[];
  price: { found: boolean; source: 'structured' | 'text' | null };
  photoCount: number;
  dpeHint: boolean | null;
  badTraffic: string | null;
  signals: Signal[];
  verdict: Verdict;
  reasons: string[];
  warnings: string[];
};

const BLOCK_STATUSES = new Set([401, 403, 407, 429, 451]);
const GONE_STATUSES = new Set([404, 410]);

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * Undo the escapes that hide URLs and markers: JSON escapes in embedded data,
 * numeric entities (Akamai block pages encode "#", "." and ":" this way), &quot;.
 */
export function normalizeBody(body: string): string {
  return body
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0022/g, '"')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&quot;/g, '"');
}

export function extractTitle(body: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (!m?.[1]) return null;
  const title = m[1].replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 150) : null;
}

export function visibleTextLength(body: string): number {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

const EMBEDDED: ReadonlyArray<[string, RegExp]> = [
  ['__NEXT_DATA__', /<script[^>]+id=["']__NEXT_DATA__["']/i],
  ['next-rsc', /self\.__next_f\.push/],
  ['json-ld', /<script[^>]+type=["']application\/ld\+json["']/i],
  ['og', /<meta[^>]+property=["']og:(?:title|image|description)["']/i],
  ['initial-state', /__INITIAL_STATE__|__PRELOADED_STATE__|__UFRN_LIFECYCLE_SERVERREQUEST__|__APOLLO_STATE__/],
];

export function detectEmbeddedData(body: string): string[] {
  return EMBEDDED.filter(([, re]) => re.test(body)).map(([name]) => name);
}

export function countPhotos(normalized: string, photo: RegExp): number {
  const ids = new Set<string>();
  for (const m of normalized.matchAll(new RegExp(photo.source, photo.flags))) {
    if (m[1]) ids.add(m[1].toLowerCase());
  }
  return ids.size;
}

export function findPrice(
  normalized: string,
  platform: ProbePlatform,
): Analysis['price'] {
  for (const { source, re } of platform.price) {
    if (re.test(normalized)) return { found: true, source };
  }
  return { found: false, source: null };
}

export function extractBadTraffic(normalized: string): string | null {
  const m = /["']?bad_traffic["']?\s*[:=]\s*["']([a-z_-]+)["']/i.exec(normalized);
  return m?.[1]?.toLowerCase() ?? null;
}

const DPE_HINT = /energy_rate|energyClass|energy_class|"dpe"|classe [ée]nergie|diagnostic de performance [ée]nerg/i;

/**
 * Anti-bot evidence, on the normalized body. "strong" means the response itself is a block or challenge page;
 * "weak" means protection is present on the site (a JS tag, a cookie) without blocking.
 * Weak signals alone never make a verdict "bloqué": DataDome and Cloudflare scripts
 * load on normal pages too.
 */
export function detectSignals(raw: RawResponse, visibleChars: number): Signal[] {
  const { body, headers, cookieNames, status } = raw;
  const signals: Signal[] = [];
  const add = (id: string, strength: Signal['strength'], detail: string) =>
    signals.push({ id, strength, detail });
  const cookies = new Set(cookieNames.map((c) => c.toLowerCase()));

  // DataDome
  if (/var\s+dd\s*=\s*\{/.test(body) || /(?:geo|ct)\.captcha-delivery\.com\/(?:captcha|interstitial|[ci]\.js)/i.test(body)) {
    add('datadome-challenge', 'strong', 'page de captcha DataDome (captcha-delivery.com)');
  } else if ('x-dd-b' in headers || (BLOCK_STATUSES.has(status) && 'x-datadome' in headers)) {
    add('datadome-block', 'strong', `réponse DataDome HTTP ${status}`);
  } else if ('x-datadome' in headers || cookies.has('datadome') || /js\.datadome\.co|datadome/i.test(body)) {
    add('datadome-present', 'weak', 'DataDome actif sur le site, page servie');
  }

  // Cloudflare
  if (headers['cf-mitigated'] === 'challenge' || /window\._cf_chl_opt|\/cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate/.test(body)) {
    add('cloudflare-challenge', 'strong', 'défi Cloudflare (cf-chl)');
  } else if ('cf-ray' in headers || cookies.has('__cf_bm')) {
    add('cloudflare-present', 'weak', 'derrière Cloudflare');
  }

  // Akamai
  if (/<title>\s*Access Denied\s*<\/title>/i.test(body) && /Reference\s*#\s*[\d.a-f]+/i.test(body)) {
    add('akamai-denied', 'strong', 'page Access Denied Akamai');
  } else if (/errors\.edgesuite\.net/i.test(body)) {
    add('akamai-denied', 'strong', 'erreur Akamai (edgesuite)');
  } else if (cookies.has('_abck') || cookies.has('ak_bmsc') || cookies.has('bm_sz')) {
    add('akamai-present', 'weak', 'Akamai Bot Manager actif');
  }

  // PerimeterX / HUMAN
  if (/px-captcha|_pxCaptcha/i.test(body)) {
    add('perimeterx-challenge', 'strong', 'captcha PerimeterX');
  } else if (/_pxAppId|client\.perimeterx\.net/i.test(body) || cookies.has('_px3') || cookies.has('_pxvid')) {
    add('perimeterx-present', 'weak', 'PerimeterX actif');
  }

  // Imperva / Incapsula
  if (/_Incapsula_Resource/i.test(body) && visibleChars < 500) {
    add('imperva-challenge', 'strong', 'défi Imperva (Incapsula)');
  } else if ('x-iinfo' in headers || [...cookies].some((c) => c.startsWith('incap_ses') || c.startsWith('visid_incap'))) {
    add('imperva-present', 'weak', 'Imperva actif');
  }

  if (BLOCK_STATUSES.has(status)) {
    add('http-status', 'strong', `HTTP ${status}`);
  }

  if (status >= 200 && status < 300 && visibleChars < 200) {
    add('empty-page', 'weak', `page quasi vide (${visibleChars} caractères visibles)`);
  }

  if (/captcha/i.test(body) && !signals.some((s) => s.strength === 'strong')) {
    add('captcha-word', 'weak', 'le mot « captcha » apparaît dans la page');
  }

  return signals;
}

export function analyze(platform: ProbePlatform, raw: RawResponse): Analysis {
  const normalized = normalizeBody(raw.body);
  const visibleTextChars = visibleTextLength(raw.body);
  const embeddedData = detectEmbeddedData(raw.body);
  const price = findPrice(normalized, platform);
  const photoCount = countPhotos(normalized, platform.photo);
  const dpeHint = platform.vertical === 'immo' ? DPE_HINT.test(normalized) : null;
  const badTraffic = platform.reportsBadTraffic ? extractBadTraffic(normalized) : null;
  const signals = detectSignals({ ...raw, body: normalized }, visibleTextChars);

  const reasons: string[] = [];
  const warnings: string[] = [];
  const strong = signals.filter((s) => s.strength === 'strong');
  const hasData = price.found || photoCount > 0 || embeddedData.length > 0;

  let verdict: Verdict;
  if (GONE_STATUSES.has(raw.status)) {
    verdict = 'expirée';
    reasons.push(`HTTP ${raw.status} : annonce expirée ou supprimée, en prendre une fraîche`);
  } else if (strong.length > 0) {
    verdict = 'bloqué';
    reasons.push(...strong.map((s) => s.detail));
  } else if (raw.status === 503 && signals.length > 0) {
    verdict = 'bloqué';
    reasons.push(`HTTP 503 avec protection anti-robot (${signals.map((s) => s.id).join(', ')})`);
  } else if (raw.status < 200 || raw.status >= 300) {
    verdict = 'erreur';
    reasons.push(`HTTP ${raw.status} inattendu`);
  } else if (!hasData && visibleTextChars < 200) {
    verdict = 'bloqué';
    reasons.push('page vide sans aucune donnée (rendu JavaScript ou blocage silencieux)');
  } else if (price.found && photoCount > 0) {
    verdict = 'lisible';
    reasons.push(`prix trouvé (${price.source === 'structured' ? 'données structurées' : 'texte'}), ${photoCount} photo(s)`);
  } else {
    verdict = 'partiel';
    if (!price.found) reasons.push('prix introuvable dans le HTML');
    if (photoCount === 0) reasons.push('aucune URL de photo reconnue');
  }

  if (verdict === 'lisible' && price.source === 'text') {
    warnings.push('prix trouvé seulement dans le texte : à confirmer');
  }
  if (verdict === 'lisible' && photoCount < 3) {
    warnings.push(`seulement ${photoCount} photo(s) dans le HTML : galerie peut-être chargée en JavaScript`);
  }
  if (badTraffic && badTraffic !== 'ok') {
    warnings.push(`bad_traffic=${badTraffic} : serveur détecté comme non humain`);
  }
  if (platform.reportsBadTraffic && badTraffic === null && verdict === 'lisible') {
    warnings.push('champ bad_traffic absent');
  }
  if (platform.vertical === 'immo' && dpeHint === false && verdict === 'lisible') {
    warnings.push('aucun indice de DPE dans la page');
  }
  if (raw.truncated) {
    warnings.push(`page tronquée à ${raw.bytes} octets pour l'analyse`);
  }
  for (const s of signals) {
    if (s.strength === 'weak' && verdict !== 'bloqué') warnings.push(s.detail);
  }

  return {
    title: extractTitle(raw.body),
    visibleTextChars,
    embeddedData,
    price,
    photoCount,
    dpeHint,
    badTraffic,
    signals,
    verdict,
    reasons,
    warnings,
  };
}
