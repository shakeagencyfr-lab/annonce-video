export type Vertical = 'auto' | 'immo';

export type PlatformId =
  | 'leboncoin-auto'
  | 'leboncoin-immo'
  | 'autoscout24-fr'
  | 'seloger'
  | 'lacentrale'
  | 'pap';

export type PricePattern = { source: 'structured' | 'text'; re: RegExp };

/**
 * Markers are matched against the normalized body (see normalizeBody): JSON and
 * entity escapes are undone, so write plain `"key":"value"` and `/` in patterns.
 */
export type ProbePlatform = {
  id: PlatformId;
  label: string;
  vertical: Vertical;
  release: 'V1' | 'V1.1';
  hosts: readonly string[];
  /** Path of one single listing. Search and result pages never match (rule 1). */
  listingPath: RegExp;
  /**
   * Listings tried in order, the next one only when the previous has expired.
   * Found through a search engine on 2026-09-27; they expire, refresh them on 404.
   */
  seedUrls: readonly string[];
  /** The listing's own data blob: its presence means the page was really served. */
  listingData: RegExp;
  /** In-page marker of a removed listing (served with 200 by some platforms). */
  expired?: RegExp;
  /** Id of the listing derived from its URL, used to check the page and filter photos. */
  listingKey?: (url: URL) => string | null;
  /** Capture 1 = listing id as written in the page, compared with listingKey. */
  pageId?: RegExp;
  /** Global regex over photo URLs. */
  photo: RegExp;
  /** Identity of a photo match (size and query variants collapse), null to ignore it. */
  photoKey: (m: RegExpMatchArray, listingKey: string | null) => string | null;
  /** Capture 1 = number of photos announced by the page itself. */
  declaredPhotos?: RegExp;
  price: readonly PricePattern[];
  /** Capture 1 = DPE letter. */
  dpe?: readonly RegExp[];
  reportsBadTraffic: boolean;
};

const TITLE_PRICE: PricePattern = {
  source: 'text',
  re: /<title[^>]*>[^<]*?\d[\d   .]*\s?(?:€|&euro;)/i,
};

const TEXT_PRICE: PricePattern = {
  source: 'text',
  re: /\d{1,3}(?:[   .]\d{3})+(?:[   ]|&nbsp;)?(?:€|&euro;|EUR\b)/,
};

const JSON_LD_PRICE: PricePattern = {
  source: 'structured',
  re: /"@type"\s*:\s*"(?:Offer|AggregateOffer)"[^}]{0,400}?"price"\s*:\s*"?\d/i,
};

const lastPathNumber = (url: URL) => /(\d+)\/?$/.exec(url.pathname)?.[1] ?? null;

const LEBONCOIN = {
  label: 'Leboncoin',
  release: 'V1',
  hosts: ['www.leboncoin.fr', 'leboncoin.fr'],
  // The ad object itself, or the Next.js route of an ad page (both seen in 2021-2026 pages).
  listingData: /"ad"\s*:\s*\{[^{}]{0,300}?"list_id"\s*:\s*\d+|"page"\s*:\s*"(?:\/ad\/\[[a-z]+\]\/\[id\]|\/ClassifiedAd)"/,
  listingKey: lastPathNumber,
  pageId: /"list_id"\s*:\s*(\d+)/,
  // Ids are mostly hex, but some start with "gh" (seen in 2026): not strictly hex.
  // The 40-character id with .jpg excludes store logos (UUID ids, no extension).
  photo: /img\.leboncoin\.fr\/api\/v1\/lbcpb1\/images\/([0-9a-z]{2}\/[0-9a-z]{2}\/[0-9a-z]{2}\/[0-9a-z]{40})\.jpg/gi,
  photoKey: (m: RegExpMatchArray) => m[1] ?? null,
  declaredPhotos: /"nb_images"\s*:\s*(\d+)/,
  price: [
    { source: 'structured', re: /"price"\s*:\s*\[\s*\d+/ },
    { source: 'structured', re: /"price_cents"\s*:\s*\d+/ },
    TITLE_PRICE,
  ],
  reportsBadTraffic: false,
} as const;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** 69119858725 -> E119858725: the first two digits are a char code (69 = E). */
export function laCentraleReference(url: URL): string | null {
  const id = /-(\d{11})\.html$/.exec(url.pathname)?.[1];
  if (!id) return null;
  return String.fromCharCode(Number(id.slice(0, 2))) + id.slice(2);
}

export const PLATFORMS: readonly ProbePlatform[] = [
  {
    ...LEBONCOIN,
    id: 'leboncoin-auto',
    vertical: 'auto',
    listingPath: /^\/ad\/voitures\/\d+\/?$/,
    seedUrls: [
      'https://www.leboncoin.fr/ad/voitures/3209507340',
      'https://www.leboncoin.fr/ad/voitures/3271024441',
      'https://www.leboncoin.fr/ad/voitures/3261152569',
    ],
  },
  {
    ...LEBONCOIN,
    id: 'leboncoin-immo',
    vertical: 'immo',
    listingPath: /^\/ad\/ventes_immobilieres\/\d+\/?$/,
    seedUrls: [
      'https://www.leboncoin.fr/ad/ventes_immobilieres/3259370552',
      'https://www.leboncoin.fr/ad/ventes_immobilieres/3251436502',
      'https://www.leboncoin.fr/ad/ventes_immobilieres/3233832543',
    ],
    dpe: [/"key"\s*:\s*"energy_rate"[^{}]*?"value"\s*:\s*"([a-g])"/i],
  },
  {
    id: 'autoscout24-fr',
    label: 'AutoScout24.fr',
    vertical: 'auto',
    release: 'V1',
    hosts: ['www.autoscout24.fr', 'autoscout24.fr'],
    listingPath: new RegExp(`^\\/offres\\/[a-z0-9_-]+-${UUID}\\/?$`, 'i'),
    seedUrls: [
      'https://www.autoscout24.fr/offres/peugeot-3008-hybrid-145-e-dcs6-gt-electrique-essence-blanc-fb8ad31a-0ba8-40fd-ad7d-ac421aca199c',
      'https://www.autoscout24.fr/offres/renault-clio-v-1-0-tce-100-initial-essence-cat_ma60mo1961-2c3186f5-8eb0-4c81-84d7-3d9c7e35240b',
      'https://www.autoscout24.fr/offres/renault-megane-e-tech-electric-ev60-220ch-techno-super-charge-electrique-cat_ma60mo1965-46a15532-cdb5-4ad4-b6e9-06532b80af8c',
    ],
    listingData: /"listingDetails"\s*:\s*\{/,
    listingKey: (url) => new RegExp(`-(${UUID})\\/?$`, 'i').exec(url.pathname)?.[1]?.toLowerCase() ?? null,
    photo: new RegExp(`listing-images\\/(${UUID})_([0-9a-f-]{8,})\\.(?:jpe?g|webp|png)`, 'gi'),
    photoKey: (m, key) => (key && m[1]?.toLowerCase() !== key ? null : (m[2] ?? null)),
    price: [
      { source: 'structured', re: /"priceRaw"\s*:\s*\d+/ },
      { source: 'structured', re: /"cost"\s*:\s*"?\d+/ },
      JSON_LD_PRICE,
      TITLE_PRICE,
    ],
    reportsBadTraffic: true,
  },
  {
    id: 'seloger',
    label: 'SeLoger',
    vertical: 'immo',
    release: 'V1',
    hosts: ['www.seloger.com', 'seloger.com'],
    // 2 to 4 location segments, then an id that contains a digit.
    listingPath: /^\/annonces?\/(?:achat|locations?)\/(?:[a-z0-9-]+\/){2,4}(?=[a-z0-9]*\d)[a-z0-9]{6,}(?:\.htm)?\/?$/i,
    seedUrls: [
      'https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26ZCAGW19827',
      'https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26A14HBRCFAV',
      'https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/265MSJKKI63I',
    ],
    listingData: /"app_cldp"\s*:\s*\{\s*"data"\s*:\s*\{\s*"classified"\s*:\s*\{/,
    // Scoped to the listing app: other micro-apps of the same blob carry their own errors.
    expired: /"app_cldp"\s*:\s*\{\s*"data"\s*:\s*null\s*,\s*"error"\s*:\s*\{[^}]*(?:"statusCode"\s*:\s*410\b|classified not available)/,
    photo: /mms\.seloger\.com\/([0-9a-z/_-]+?)\.(?:jpe?g|png|webp)/gi,
    photoKey: (m) => m[1] ?? null,
    declaredPhotos: /"photos_nb"\s*:\s*(\d+)/,
    price: [
      { source: 'structured', re: /"av_items"\s*:\s*\[\s*\{[^\]]{0,2000}?"price"\s*:\s*\d+/ },
      { source: 'structured', re: /"hardFacts"\s*:\s*\{[\s\S]{0,3000}?"price"\s*:\s*\{\s*"value"\s*:\s*"[^"]*\d/ },
      TITLE_PRICE,
    ],
    dpe: [
      /"energy_letter"\s*:\s*"([A-G])"/,
      /"efficiencyClass"\s*:\s*\{\s*"index"\s*:\s*\d+\s*,\s*"rating"\s*:\s*"([A-G])"/,
    ],
    reportsBadTraffic: false,
  },
  {
    id: 'lacentrale',
    label: 'La Centrale',
    vertical: 'auto',
    release: 'V1.1',
    hosts: ['www.lacentrale.fr', 'lacentrale.fr'],
    listingPath: /^\/auto-occasion-annonce-\d{11}\.html$/,
    seedUrls: [
      'https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html',
      'https://www.lacentrale.fr/auto-occasion-annonce-69119839851.html',
    ],
    listingData: /(?:var\s+|window\.)(?:CLASSIFIED_MAIN_INFOS|CLASSIFIED_GALLERY|SummaryInformationData)\s*=/,
    listingKey: laCentraleReference,
    photo: /(?:pictures\.lacentrale\.fr\/classifieds|image-annonce\.lacentrale\.fr\/\d+x\d+)\/([A-Z]\d{9,10})_STANDARD_(\d{1,3})\.(?:jpe?g|webp)/g,
    photoKey: (m, key) => (key && m[1] !== key ? null : `${m[1]}_${m[2]}`),
    price: [{ source: 'structured', re: /"price"\s*:\s*\d{3,7}\b/ }, JSON_LD_PRICE, TITLE_PRICE],
    reportsBadTraffic: false,
  },
  {
    id: 'pap',
    label: 'PAP',
    vertical: 'immo',
    release: 'V1.1',
    hosts: ['www.pap.fr', 'pap.fr'],
    listingPath: /^\/annonces\/[a-z0-9-]+-r\d+\/?$/,
    seedUrls: [
      'https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049',
      'https://www.pap.fr/annonces/maison-bouc-bel-air-13320-r464701242',
      'https://www.pap.fr/annonces/appartement-marseille-4e-13004-r464202421',
    ],
    listingData: /"@type"\s*:\s*"Product"|class="[^"]*\bitem-price\b/,
    // A removed listing serves the search page, whose canonical is /annonce/ (singular).
    expired: /<link(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']https:\/\/www\.pap\.fr\/annonce\//i,
    listingKey: lastPathNumber,
    pageId: /<link(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["'][^"']*?-r(\d+)\/?["']/i,
    photo: /cdn\.pap\.fr\/photos\/pap\/(?:[0-9a-f]{2}\/){2}([0-9a-f]{32})\/[0-9a-f]+-p\d+\.(?:webp|jpe?g)/gi,
    photoKey: (m) => m[1] ?? null,
    price: [
      JSON_LD_PRICE,
      { source: 'structured', re: /"price"\s*:\s*"?\d{3,}/ },
      { source: 'structured', re: /class="[^"]*\bitem-price\b[^"]*"[^>]*>\s*\d/ },
      TITLE_PRICE,
      TEXT_PRICE,
    ],
    dpe: [
      /\benergy-rank-([a-g])\b/i,
      /class="[^"]*\benergy-indice\b[^"]*"[\s\S]{0,2000}?<li[^>]*class="[^"]*\bactive\b[^"]*"[^>]*>\s*([A-G])\b/,
    ],
    reportsBadTraffic: false,
  },
];

export function getPlatform(id: string): ProbePlatform | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

/** Platform whose host and single-listing path both match, or undefined. */
export function matchPlatform(url: URL): ProbePlatform | undefined {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  return PLATFORMS.find((p) => p.hosts.includes(host) && p.listingPath.test(url.pathname));
}
