import { analyze, detectSignals, type Analysis, type Signal } from './analyze';
import { DEFAULT_USER_AGENT, fetchListing, type FetchOptions, type HopMeta } from './fetch';
import { PLATFORMS, matchPlatform, type PlatformId, type ProbePlatform } from './platforms';

export type ProbeTarget = { platform: ProbePlatform; urls: URL[] };

export type Rejected = { input: string; reason: string };

export type Attempt = {
  url: string;
  status: number | null;
  verdict: Analysis['verdict'];
  durationMs: number | null;
  redirectedHome: boolean;
};

export type ProbeResult = Omit<Analysis, 'verdict'> & {
  platform: PlatformId;
  label: string;
  vertical: ProbePlatform['vertical'];
  release: ProbePlatform['release'];
  url: string | null;
  finalUrl: string | null;
  redirects: string[];
  status: number | null;
  bytes: number | null;
  ttfbMs: number | null;
  durationMs: number | null;
  headers: Record<string, string>;
  cookieNames: string[];
  verdict: Analysis['verdict'];
  /** Every listing tried for this platform, in order (next one only after an expired one). */
  attempts: Attempt[];
  /** The listing URL answered with a redirect to the site's homepage. */
  redirectedHome: boolean;
};

export const MAX_CANDIDATES_PER_PLATFORM = 3;
export const MAX_INPUT_URLS = PLATFORMS.length * MAX_CANDIDATES_PER_PLATFORM;

/**
 * Candidate listings per platform: the URLs passed in replace the seeds of their
 * platform. Only single-listing URLs are accepted, at most three per platform, and
 * they are read one at a time, the next only when the previous one has expired (rule 1).
 */
export function resolveTargets(
  inputs: readonly string[],
  platformFilter: readonly string[],
): { targets: ProbeTarget[]; rejected: Rejected[] } {
  const rejected: Rejected[] = [];
  const overrides = new Map<PlatformId, URL[]>();

  inputs.forEach((input, index) => {
    if (index >= MAX_INPUT_URLS) {
      rejected.push({ input, reason: `au plus ${MAX_INPUT_URLS} URLs par appel` });
      return;
    }
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      rejected.push({ input, reason: 'URL invalide' });
      return;
    }
    // Only the canonical listing URL is fetched: no fragment, no query string.
    url.hash = '';
    url.search = '';
    const platform = matchPlatform(url);
    if (!platform) {
      rejected.push({ input, reason: "pas une page d'annonce d'une plateforme prise en charge" });
      return;
    }
    const list = overrides.get(platform.id) ?? [];
    if (list.some((u) => u.href === url.href)) return;
    if (list.length >= MAX_CANDIDATES_PER_PLATFORM) {
      rejected.push({ input, reason: `au plus ${MAX_CANDIDATES_PER_PLATFORM} annonces par plateforme` });
      return;
    }
    list.push(url);
    overrides.set(platform.id, list);
  });

  const filter = new Set(platformFilter);
  const targets = PLATFORMS.filter((p) => filter.size === 0 || filter.has(p.id)).map((platform) => ({
    platform,
    urls: overrides.get(platform.id) ?? platform.seedUrls.slice(0, MAX_CANDIDATES_PER_PLATFORM).map((u) => new URL(u)),
  }));
  for (const id of filter) {
    if (!PLATFORMS.some((p) => p.id === id)) rejected.push({ input: id, reason: 'plateforme inconnue' });
  }
  return { targets, rejected };
}

function emptyResult(platform: ProbePlatform, url: URL | null): ProbeResult {
  return {
    platform: platform.id,
    label: platform.label,
    vertical: platform.vertical,
    release: platform.release,
    url: url?.href ?? null,
    finalUrl: null,
    redirects: [],
    status: null,
    bytes: null,
    ttfbMs: null,
    durationMs: null,
    headers: {},
    cookieNames: [],
    genericTitle: null,
    visibleTextChars: 0,
    embeddedData: [],
    listingData: false,
    pageId: null,
    idMatches: null,
    price: { found: false, source: null },
    photoCount: 0,
    declaredPhotoCount: null,
    dpe: null,
    badTraffic: null,
    signals: [],
    verdict: 'non testé',
    reasons: [],
    warnings: [],
    attempts: [],
    redirectedHome: false,
  };
}

export type ProbeConfig = Omit<FetchOptions, 'followRedirect'>;

export const DEFAULT_CONFIG: ProbeConfig = {
  userAgent: DEFAULT_USER_AGENT,
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
};

/** Anti-bot signals carried by the headers of a response whose body was not analysed. */
function hopSignals(hop: HopMeta): Signal[] {
  return detectSignals({ ...hop, body: '', bytes: 0, truncated: false }, 0).filter((s) => s.id !== 'captcha-word');
}

function withHop(result: ProbeResult, hop: HopMeta | null): Signal[] {
  if (!hop) return [];
  result.status = hop.status;
  result.headers = hop.headers;
  result.cookieNames = hop.cookieNames;
  result.signals = hopSignals(hop);
  return result.signals;
}

/** One GET of one listing, analysed. */
export async function probeUrl(platform: ProbePlatform, url: URL, config: ProbeConfig): Promise<ProbeResult> {
  const result = emptyResult(platform, url);
  const outcome = await fetchListing(url, {
    ...config,
    followRedirect: (next) => matchPlatform(next)?.id === platform.id,
  });
  result.redirects = outcome.redirects;
  result.durationMs = outcome.durationMs;
  result.ttfbMs = outcome.ttfbMs;

  if (outcome.kind === 'error') {
    const strong = withHop(result, outcome.hop).filter((s) => s.strength === 'strong');
    if (outcome.cookieLoop) {
      result.verdict = 'bloqué';
      result.reasons.push(`${outcome.error} : contrôle anti-robot par cookie probable`);
    } else if (strong.length > 0) {
      result.verdict = 'bloqué';
      result.reasons.push(...strong.map((s) => s.detail), outcome.error);
    } else {
      result.verdict = 'erreur';
      result.reasons.push(outcome.error);
    }
    return result;
  }

  if (outcome.kind === 'redirect-off-listing') {
    const signals = withHop(result, outcome.hop);
    const strong = signals.filter((s) => s.strength === 'strong');
    const target = new URL(outcome.location);
    result.redirectedHome = target.pathname === '/' || target.pathname === '';
    const where =
      result.redirectedHome
        ? `la page d’accueil ${target.href} : annonce expirée ou blocage discret`
        : `${target.href}, hors d’une page d’annonce : annonce probablement expirée`;
    result.finalUrl = outcome.finalUrl;
    if (strong.length > 0) {
      result.verdict = 'bloqué';
      result.reasons.push(...strong.map((s) => s.detail), `HTTP ${outcome.hop.status} vers ${target.href}`);
    } else {
      result.verdict = 'expirée';
      result.reasons.push(`HTTP ${outcome.hop.status} vers ${where} ; redirection non suivie`);
      for (const s of signals) result.warnings.push(`redirection émise avec protection anti-robot : ${s.detail}`);
    }
    return result;
  }

  const finalUrl = new URL(outcome.finalUrl);
  return {
    ...result,
    ...analyze(platform, outcome.raw, finalUrl),
    finalUrl: outcome.finalUrl,
    status: outcome.raw.status,
    bytes: outcome.raw.bytes,
    headers: outcome.raw.headers,
    cookieNames: outcome.raw.cookieNames,
  };
}

/** Candidates in order; the next is read only if the previous listing has expired. */
export async function probeTarget(
  target: ProbeTarget,
  config: ProbeConfig,
  hasTime: () => boolean = () => true,
): Promise<ProbeResult> {
  const attempts: Attempt[] = [];
  let last: ProbeResult | null = null;
  for (const url of target.urls) {
    if (!hasTime()) break;
    last = await probeUrl(target.platform, url, config);
    attempts.push({
      url: url.href,
      status: last.status,
      verdict: last.verdict,
      durationMs: last.durationMs,
      redirectedHome: last.redirectedHome,
    });
    if (last.verdict !== 'expirée') break;
  }
  if (!last) {
    const result = emptyResult(target.platform, target.urls[0] ?? null);
    result.reasons.push(
      target.urls.length === 0 ? `aucune URL : passer ?url=<annonce ${target.platform.id} récente>` : 'temps imparti dépassé',
    );
    return result;
  }
  if (attempts.length > 1 && attempts.every((a) => a.redirectedHome)) {
    // Fresh listings do not all expire at once: sending every one home is a silent block.
    last.verdict = 'bloqué';
    last.reasons.push(`${attempts.length} annonces récentes, toutes redirigées vers l’accueil : blocage discret probable`);
  } else if (attempts.length > 1 && last.verdict === 'expirée') {
    last.reasons.push(`${attempts.length} annonces essayées, toutes expirées ou redirigées`);
  }
  return { ...last, attempts };
}

/** Sequential on purpose: one listing read at a time, timings comparable. */
export async function probeAll(
  targets: readonly ProbeTarget[],
  config: ProbeConfig,
  budgetMs: number,
  onResult: (result: ProbeResult) => void = () => {},
): Promise<ProbeResult[]> {
  const started = performance.now();
  const hasTime = () => performance.now() - started + config.timeoutMs <= budgetMs;
  const results: ProbeResult[] = [];
  for (const target of targets) {
    let result: ProbeResult;
    try {
      result = await probeTarget(target, config, hasTime);
    } catch (err) {
      result = emptyResult(target.platform, target.urls[0] ?? null);
      result.verdict = 'erreur';
      result.reasons.push(`erreur interne : ${err instanceof Error ? err.message : String(err)}`);
    }
    onResult(result);
    results.push(result);
  }
  return results;
}
