/**
 * Biggest photo variant worth downloading for a 1080p video, per photo host
 * (docs/etape-0.md, "Taille des photos"). Only documented variants of unsigned URLs
 * are requested: signed URLs and unknown hosts are returned unchanged, never rebuilt.
 * If the variant turns out to be missing, the caller falls back to the original URL.
 */

/** AutoScout24 serves any size named by the path suffix: `…jpg/{W}x{H}.webp`. */
const AUTOSCOUT24_SIZE = /\/(\d+)x(\d+)\.(?:webp|jpe?g)$/i;
const FULL_HD = { width: 1920, height: 1080 };
const AUTOSCOUT24_FULL_HD = `/${FULL_HD.width}x${FULL_HD.height}.webp`;

/** Leboncoin picks the size with `?rule=`: these are smaller than `ad-large` (~600×800). */
const LEBONCOIN_SMALL_RULES = new Set(['ad-thumb', 'ad-small', 'ad-image']);
const LEBONCOIN_LARGE_RULE = 'ad-large';

/** Splits the URL as written, so the parts we do not touch keep their exact spelling. */
function splitUrl(url: string): { path: string; query: string; hash: string } {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  return {
    path: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt < 0 ? '' : beforeHash.slice(queryAt),
    hash,
  };
}

/**
 * Only a size that fits inside 1920x1080 is replaced: a bigger or taller one (e.g.
 * 1600x1200) may already give more pixels than the Full HD box, so it is kept.
 */
function autoscout24(url: string): string {
  const { path, query, hash } = splitUrl(url);
  const size = AUTOSCOUT24_SIZE.exec(path);
  if (!size || Number(size[1]) > FULL_HD.width || Number(size[2]) > FULL_HD.height) return url;
  return path.replace(AUTOSCOUT24_SIZE, AUTOSCOUT24_FULL_HD) + query + hash;
}

/** Only the `rule` parameter changes; the others are left byte for byte. */
function leboncoin(url: string): string {
  const { path, query, hash } = splitUrl(url);
  const rule = /([?&])rule=([^&]*)/.exec(query);
  if (!rule || !LEBONCOIN_SMALL_RULES.has(rule[2] ?? '')) return url;
  const updated = query.replace(/([?&])rule=[^&]*/, `$1rule=${LEBONCOIN_LARGE_RULE}`);
  return path + updated + hash;
}

export function largestVariant(url: string): string {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return url;
    host = parsed.hostname.toLowerCase();
  } catch {
    return url;
  }
  switch (host) {
    case 'prod.pictures.autoscout24.net':
      return autoscout24(url);
    case 'img.leboncoin.fr':
      return leboncoin(url);
    // SeLoger (mms.seloger.com) signs path and query with ci_seal: any change breaks it.
    // La Centrale (1096x829, the biggest known unsigned size) and PAP (largest size
    // still unknown) are kept as given, like any other host.
    default:
      return url;
  }
}
