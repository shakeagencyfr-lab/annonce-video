import type { RawResponse } from './analyze';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const KEPT_HEADERS = [
  'content-type',
  'content-encoding',
  'server',
  'via',
  'x-cache',
  'x-datadome',
  'x-datadome-cid',
  'x-dd-b',
  'cf-ray',
  'cf-cache-status',
  'cf-mitigated',
  'x-iinfo',
  'akamai-grn',
  'x-akamai-transformed',
  'retry-after',
] as const;

export type FetchOptions = {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Redirects are followed only while this accepts the target (a single listing page). */
  followRedirect: (target: URL) => boolean;
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
      status: number;
      location: string;
      durationMs: number;
    }
  | { kind: 'error'; error: string; durationMs: number; redirects: string[] };

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value.slice(0, 200);
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
    if (value.byteLength >= room) {
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

/**
 * One GET of one listing page. The body stays in memory for analysis only:
 * it is never logged, stored or returned (rule 2).
 */
export async function fetchListing(url: URL, opts: FetchOptions): Promise<FetchOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const redirects: string[] = [];
  let current = url;

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        cache: 'no-store',
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
      const ttfbMs = elapsed();

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const target = new URL(location, current);
        if (!opts.followRedirect(target)) {
          return {
            kind: 'redirect-off-listing',
            finalUrl: current.href,
            redirects,
            status: res.status,
            location: target.href,
            durationMs: elapsed(),
          };
        }
        if (hop >= opts.maxRedirects) {
          return { kind: 'error', error: `plus de ${opts.maxRedirects} redirections`, durationMs: elapsed(), redirects };
        }
        redirects.push(target.href);
        current = target;
        continue;
      }

      const headers = pickHeaders(res.headers);
      const { bytes, total, truncated } = await readCapped(res, opts.maxBytes);
      return {
        kind: 'response',
        finalUrl: current.href,
        redirects,
        ttfbMs,
        durationMs: elapsed(),
        raw: {
          status: res.status,
          headers,
          cookieNames: cookieNames(res.headers),
          body: decode(bytes, headers['content-type']),
          bytes: total,
          truncated,
        },
      };
    }
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === 'TimeoutError' || err.name === 'AbortError'
          ? `délai dépassé (${opts.timeoutMs} ms)`
          : `${err.name}: ${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}`
        : String(err);
    return { kind: 'error', error, durationMs: elapsed(), redirects };
  }
}
