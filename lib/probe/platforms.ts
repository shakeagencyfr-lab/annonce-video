export type Vertical = 'auto' | 'immo';

export type PlatformId =
  | 'leboncoin-auto'
  | 'leboncoin-immo'
  | 'autoscout24-fr'
  | 'seloger'
  | 'lacentrale'
  | 'pap';

export type PricePattern = { source: 'structured' | 'text'; re: RegExp };

export type ProbePlatform = {
  id: PlatformId;
  label: string;
  vertical: Vertical;
  release: 'V1' | 'V1.1';
  hosts: readonly string[];
  /** Path of one single listing. Search and result pages never match (rule 1). */
  listingPath: RegExp;
  /** Seed listing for the probe. Listings expire: replace with a fresh one on 404. */
  defaultUrl: string | null;
  /** Global regex; capture group 1 identifies a photo (size and query variants collapse). */
  photo: RegExp;
  price: readonly PricePattern[];
  reportsBadTraffic: boolean;
};

const GENERIC_PRICE: readonly PricePattern[] = [
  { source: 'structured', re: /"@type"\s*:\s*"Offer"[^}]*?"price"\s*:\s*"?\d/i },
  { source: 'structured', re: /itemprop=["']price["'][^>]*content=["']?\d/i },
  { source: 'structured', re: /property=["'](?:product|og):price:amount["'][^>]*content=["']?\d/i },
  { source: 'text', re: /\d{1,3}(?:[   .]\d{3})+(?:[   ]|&nbsp;)?(?:€|&euro;|EUR\b)/ },
];

const LEBONCOIN_PRICE: readonly PricePattern[] = [
  { source: 'structured', re: /"price"\s*:\s*\[\s*\d+/i },
  { source: 'structured', re: /"price_cents"\s*:\s*\d+/i },
  ...GENERIC_PRICE,
];

const LEBONCOIN_PHOTO =
  /img\.leboncoin\.fr\/api\/v1\/lbcpb1\/images\/([a-z0-9/_-]+?\.jpe?g)/gi;

export const PLATFORMS: readonly ProbePlatform[] = [
  {
    id: 'leboncoin-auto',
    label: 'Leboncoin',
    vertical: 'auto',
    release: 'V1',
    hosts: ['www.leboncoin.fr', 'leboncoin.fr'],
    listingPath: /^\/ad\/voitures\/\d+\/?$/,
    defaultUrl: 'https://www.leboncoin.fr/ad/voitures/3209507340',
    photo: LEBONCOIN_PHOTO,
    price: LEBONCOIN_PRICE,
    reportsBadTraffic: false,
  },
  {
    id: 'leboncoin-immo',
    label: 'Leboncoin',
    vertical: 'immo',
    release: 'V1',
    hosts: ['www.leboncoin.fr', 'leboncoin.fr'],
    listingPath: /^\/ad\/ventes_immobilieres\/\d+\/?$/,
    defaultUrl: null,
    photo: LEBONCOIN_PHOTO,
    price: LEBONCOIN_PRICE,
    reportsBadTraffic: false,
  },
  {
    id: 'autoscout24-fr',
    label: 'AutoScout24.fr',
    vertical: 'auto',
    release: 'V1',
    hosts: ['www.autoscout24.fr', 'autoscout24.fr'],
    listingPath: /^\/offres\/[a-z0-9-]+\/?$/i,
    defaultUrl: null,
    photo: /listing-images\/([0-9a-z-]+_[0-9a-z-]+)\.(?:jpe?g|webp|png)/gi,
    price: [
      { source: 'structured', re: /"cost"\s*:\s*"?\d+/i },
      { source: 'structured', re: /"price"\s*:\s*"?\d/i },
      ...GENERIC_PRICE,
    ],
    reportsBadTraffic: true,
  },
  {
    id: 'seloger',
    label: 'SeLoger',
    vertical: 'immo',
    release: 'V1',
    hosts: ['www.seloger.com', 'seloger.com'],
    listingPath: /^\/annonces?\/(?:achat|locations?)\/(?:[a-z0-9-]+\/)+[a-z0-9]+(?:\.htm)?\/?$/i,
    defaultUrl:
      'https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/bouches-du-rhone-13/marseille-13000/26ZCAGW19827',
    photo: /mms\.seloger\.com\/([a-z0-9/_.-]+?\.(?:jpe?g|webp|png))/gi,
    price: [{ source: 'structured', re: /"price"\s*:\s*\{?[^}]{0,40}?\d{4,}/i }, ...GENERIC_PRICE],
    reportsBadTraffic: false,
  },
  {
    id: 'lacentrale',
    label: 'La Centrale',
    vertical: 'auto',
    release: 'V1.1',
    hosts: ['www.lacentrale.fr', 'lacentrale.fr'],
    listingPath: /^\/auto-occasion-annonce-\d+\.html$/,
    defaultUrl: 'https://www.lacentrale.fr/auto-occasion-annonce-69119858725.html',
    photo: /image-annonce\.lacentrale\.fr\/(?:[^\s"'<>]*\/)?([a-z]?\d+_[a-z]+_\d+)\.(?:jpe?g|webp)/gi,
    price: [{ source: 'structured', re: /"price"\s*:\s*"?\d{3,}/i }, ...GENERIC_PRICE],
    reportsBadTraffic: false,
  },
  {
    id: 'pap',
    label: 'PAP',
    vertical: 'immo',
    release: 'V1.1',
    hosts: ['www.pap.fr', 'pap.fr'],
    listingPath: /^\/annonces\/[a-z0-9-]+-r\d+\/?$/,
    defaultUrl: 'https://www.pap.fr/annonces/appartement-marseille-13e-13013-r463901049',
    photo: /cdn\.pap\.fr\/photos\/pap\/([a-z0-9/_-]+?)-p\d+\.(?:jpe?g|webp)/gi,
    price: GENERIC_PRICE,
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
