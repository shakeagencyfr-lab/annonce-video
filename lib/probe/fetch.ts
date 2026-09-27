import type { RawResponse } from './analyze';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
export const ACCEPT_IMAGE = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

/** Headers the probe sets. Node's fetch (undici) adds its own on top, see UNDICI_ADDED_HEADERS. */
export function requestHeaders(userAgent: string, accept: string = ACCEPT_HTML): Record<string, string> {
  return {
    'user-agent': userAgent,
    accept,
    'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  };
}

/**
 * Added by undici (Node 22) on every HTTPS request: part of what the sites see, reported
 * with the results. Measured against a local HTTPS server; tests check the names.
 */
export const UNDICI_ADDED_HEADERS = ['sec-fetch-mode: cors', 'accept-encoding: br, gzip, deflate', 'connection: keep-alive'];

const KEPT_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'location',
  'server',
  'via',
  'x-cache',
  'x-datadome',
  'x-dd-b',
  'cf-ray',
  'cf-cache-status',
  'cf-mitigated',
  'x-iinfo',
  'akamai-grn',
  'x-akamai-transformed',
  'retry-after',
  'x-amzn-waf-action',
] as const;

/** Present or not, never the value: it carries the DataDome client id, like the cookie. */
const PRESENCE_ONLY_HEADERS = ['x-datadome-cid'] as const;

export type HopMeta = {
  status: number;
  headers: Record<string, string>;
  cookieNames: string[];
};

export type FetchOptions = {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Redirects are followed only while this accepts the target (a single listing page). */
  followRedirect: (target: URL) => boolean;
  /** Accept header; HTML by default. */
  accept?: string;
};

export type FetchOutcome =
  | {
      kind: 'response';
      finalUrl: string;
      redirects: string[];
      ttfbMs: number;
      durationMs: number;
      raw: RawResponse;
    }
  | {
      kind: 'redirect-off-listing';
      finalUrl: string;
      redirects: string[];
      location: string;
      ttfbMs: number;
      durationMs: number;
      hop: HopMeta;
    }
  | {
      kind: 'error';
      error: string;
      /** A redirect back to an already visited URL that sets a cookie: a cookie check. */
      cookieLoop: boolean;
      redirects: string[];
      ttfbMs: number | null;
      durationMs: number;
      /** Last response received before the error, if any (e.g. a body that stalled). */
      hop: HopMeta | null;
    };

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value.slice(0, 200);
  }
  for (const name of PRESENCE_ONLY_HEADERS) {
    if (headers.has(name)) out[name] = 'présent';
  }
  return out;
}

/** Cookie names only: values are never read or kept. */
function cookieNames(headers: Headers): string[] {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return [...new Set(all.map((c) => c.split('=', 1)[0]?.trim() ?? '').filter(Boolean))];
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), total: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, total, truncated };
}

function decode(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function isText(contentType: string | undefined): boolean {
  return !contentType || /text\/|html|xml|json|javascript/i.test(contentType);
}

function describeError(err: unknown, timeoutMs: number): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `délai dépassé (${timeoutMs} ms)`;
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.name}: ${err.message}${cause}`;
}

/**
 * One GET of one listing page, following redirects only while they stay on a
 * listing of the same platform. The body stays in memory for analysis only: it is
 * never logged, stored or returned (rule 2). No cookie is ever sent back.
 */
export async function fetchListing(url: URL, opts: FetchOptions): Promise<FetchOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const redirects: string[] = [];
  const visited = new Set<string>([url.href]);
  let current = url;
  let hop: HopMeta | null = null;
  let ttfbMs: number | null = null;

  try {
    for (let n = 0; ; n++) {
      // No `cache` option: undici would turn it into pragma/cache-control request
      // headers. The route sets fetchCache = 'force-no-store' so Next caches nothing.
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: requestHeaders(opts.userAgent, opts.accept),
      });
      ttfbMs ??= elapsed();
      hop = { status: res.status, headers: pickHeaders(res.headers), cookieNames: cookieNames(res.headers) };

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const target = new URL(location, current);
        if (visited.has(target.href)) {
          return {
            kind: 'error',
            error: `redirection en boucle vers ${target.href}${hop.cookieNames.length ? ` avec cookie (${hop.cookieNames.join(', ')})` : ''}`,
            cookieLoop: hop.cookieNames.length > 0,
            redirects,
            ttfbMs,
            durationMs: elapsed(),
            hop,
          };
        }
        if (!opts.followRedirect(target)) {
          return {
            kind: 'redirect-off-listing',
            finalUrl: current.href,
            redirects,
            location: target.href,
            ttfbMs,
            durationMs: elapsed(),
            hop,
          };
        }
        if (n >= opts.maxRedirects) {
          return {
            kind: 'error',
            error: `plus de ${opts.maxRedirects} redirections`,
            cookieLoop: false,
            redirects,
            ttfbMs,
            durationMs: elapsed(),
            hop,
          };
        }
        visited.add(target.href);
        redirects.push(target.href);
        current = target;
        continue;
      }

      const { bytes, total, truncated } = await readCapped(res, opts.maxBytes);
      const contentType = hop.headers['content-type'];
      return {
        kind: 'response',
        finalUrl: current.href,
        redirects,
        ttfbMs,
        durationMs: elapsed(),
        raw: {
          ...hop,
          // Binary content (images) is never decoded: only its first bytes are kept.
          body: isText(contentType) ? decode(bytes, contentType) : '',
          head: bytes.subarray(0, 16),
          bytes: total,
          truncated,
        },
      };
    }
  } catch (err) {
    return {
      kind: 'error',
      error: describeError(err, opts.timeoutMs),
      cookieLoop: false,
      redirects,
      ttfbMs,
      durationMs: elapsed(),
      hop,
    };
  }
}
