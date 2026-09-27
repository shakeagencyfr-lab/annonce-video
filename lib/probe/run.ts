import { analyze, type Analysis, type Verdict } from './analyze';
import { DEFAULT_USER_AGENT, fetchListing, type FetchOptions } from './fetch';
import { PLATFORMS, matchPlatform, type PlatformId, type ProbePlatform } from './platforms';

export type ProbeTarget = { platform: ProbePlatform; url: URL | null };

export type Rejected = { input: string; reason: string };

export type ProbeResult = {
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
} & Omit<Analysis, 'verdict' | 'reasons' | 'warnings'> & {
    verdict: Verdict;
    reasons: string[];
    warnings: string[];
  };

export const MAX_URLS = PLATFORMS.length;

/**
 * Seed listings, overridden per platform by the URLs passed in. At most one listing
 * per platform per call, and only single-listing URLs are accepted (rule 1).
 */
export function resolveTargets(
  inputs: readonly string[],
  platformFilter: readonly string[],
): { targets: ProbeTarget[]; rejected: Rejected[] } {
  const rejected: Rejected[] = [];
  const overrides = new Map<PlatformId, URL>();

  for (const input of inputs.slice(0, MAX_URLS)) {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      rejected.push({ input, reason: 'URL invalide' });
      continue;
    }
    url.hash = '';
    const platform = matchPlatform(url);
    if (!platform) {
      rejected.push({ input, reason: "pas une page d'annonce d'une plateforme prise en charge" });
      continue;
    }
    if (overrides.has(platform.id)) {
      rejected.push({ input, reason: `une seule annonce par plateforme et par appel (${platform.id})` });
      continue;
    }
    overrides.set(platform.id, url);
  }
  for (const input of inputs.slice(MAX_URLS)) {
    rejected.push({ input, reason: `au plus ${MAX_URLS} URLs par appel` });
  }

  const filter = new Set(platformFilter);
  const targets = PLATFORMS.filter((p) => filter.size === 0 || filter.has(p.id)).map((platform) => ({
    platform,
    url: overrides.get(platform.id) ?? (platform.defaultUrl ? new URL(platform.defaultUrl) : null),
  }));
  return { targets, rejected };
}

function emptyResult(target: ProbeTarget): ProbeResult {
  const { platform } = target;
  return {
    platform: platform.id,
    label: platform.label,
    vertical: platform.vertical,
    release: platform.release,
    url: target.url?.href ?? null,
    finalUrl: null,
    redirects: [],
    status: null,
    bytes: null,
    ttfbMs: null,
    durationMs: null,
    headers: {},
    cookieNames: [],
    title: null,
    visibleTextChars: 0,
    embeddedData: [],
    price: { found: false, source: null },
    photoCount: 0,
    dpeHint: null,
    badTraffic: null,
    signals: [],
    verdict: 'non testé',
    reasons: [],
    warnings: [],
  };
}

export type ProbeConfig = Omit<FetchOptions, 'followRedirect'>;

export const DEFAULT_CONFIG: ProbeConfig = {
  userAgent: DEFAULT_USER_AGENT,
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
};

export async function probeOne(target: ProbeTarget, config: ProbeConfig): Promise<ProbeResult> {
  const result = emptyResult(target);
  if (!target.url) {
    result.reasons.push(`aucune URL de départ : passer ?url=<annonce ${target.platform.id} récente>`);
    return result;
  }

  const outcome = await fetchListing(target.url, {
    ...config,
    followRedirect: (next) => matchPlatform(next)?.id === target.platform.id,
  });
  result.redirects = outcome.redirects;
  result.durationMs = outcome.durationMs;

  if (outcome.kind === 'error') {
    result.verdict = 'erreur';
    result.reasons.push(outcome.error);
    return result;
  }
  if (outcome.kind === 'redirect-off-listing') {
    result.finalUrl = outcome.finalUrl;
    result.status = outcome.status;
    result.verdict = 'expirée';
    result.reasons.push(
      `HTTP ${outcome.status} vers ${outcome.location} : redirection hors d'une page d'annonce, non suivie (annonce probablement expirée)`,
    );
    return result;
  }

  const analysis = analyze(target.platform, outcome.raw);
  return {
    ...result,
    ...analysis,
    finalUrl: outcome.finalUrl,
    status: outcome.raw.status,
    bytes: outcome.raw.bytes,
    ttfbMs: outcome.ttfbMs,
    headers: outcome.raw.headers,
    cookieNames: outcome.raw.cookieNames,
  };
}

/** Sequential on purpose: one listing read at a time, timings comparable. */
export async function probeAll(targets: readonly ProbeTarget[], config: ProbeConfig): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const target of targets) {
    results.push(await probeOne(target, config));
  }
  return results;
}
