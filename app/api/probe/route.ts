import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requestHeaders, UNDICI_ADDED_HEADERS } from '@/lib/probe/fetch';
import { toMarkdown } from '@/lib/probe/report';
import { DEFAULT_CONFIG, probeAll, resolveTargets } from '@/lib/probe/run';

// Step 0: can Vercel read one listing per platform? Off unless PROBE_ENABLED=1,
// which is set on the step 0 preview only. The region comes from vercel.json:
// preferredRegion has no effect on Node.js functions.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Next caches nothing, without adding cache headers to the outgoing request.
export const fetchCache = 'force-no-store';
export const maxDuration = 120;

/** Leaves room to answer before maxDuration; platforms left over are reported "non testé". */
const BUDGET_MS = 105_000;
const EXPECTED_REGION = 'cdg1';
/** Per instance: enough to stop a loop of calls on a preview, not a real rate limit. */
const COOLDOWN_MS = 30_000;

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

let running = false;
let lastRunAt = 0;

function notFound() {
  return new NextResponse('Not found', { status: 404, headers: NO_STORE });
}

function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  // The caller only ever sees a 404; the reason goes to the logs (never a value).
  if (!['1', 'true'].includes((process.env.PROBE_ENABLED ?? '').trim().toLowerCase())) {
    console.warn('probe: 404, PROBE_ENABLED is not 1');
    return notFound();
  }
  const token = process.env.PROBE_TOKEN;
  if (token && !tokenMatches(token, req.headers.get('x-probe-token'))) {
    console.warn('probe: 404, PROBE_TOKEN is set and the x-probe-token header is missing or wrong');
    return notFound();
  }

  const now = Date.now();
  if (running || now - lastRunAt < COOLDOWN_MS) {
    const wait = Math.ceil((running ? COOLDOWN_MS : COOLDOWN_MS - (now - lastRunAt)) / 1000);
    return new NextResponse(`Un test est en cours ou vient d'avoir lieu, réessayer dans ${wait} s.\n`, {
      status: 429,
      headers: { ...NO_STORE, 'retry-after': String(wait) },
    });
  }
  running = true;
  lastRunAt = now;

  try {
    const params = req.nextUrl.searchParams;
    const platformFilter = params
      .getAll('platform')
      .flatMap((p) => p.split(','))
      .map((p) => p.trim())
      .filter(Boolean);
    const { targets, rejected } = resolveTargets(params.getAll('url'), platformFilter);

    const region = process.env.VERCEL_REGION ?? 'local';
    const warnings =
      region === EXPECTED_REGION
        ? []
        : [`région ${region} au lieu de ${EXPECTED_REGION} : le résultat ne vaut pas pour la production à Paris`];

    // Derived facts only, never page content: enough to rebuild the report from the logs.
    const results = await probeAll(targets, DEFAULT_CONFIG, BUDGET_MS, (r) => {
      console.info(
        JSON.stringify({
          probe: r.platform,
          region,
          url: r.url,
          status: r.status,
          verdict: r.verdict,
          attempts: r.attempts.map((a) => `${a.status ?? '-'} ${a.verdict}`),
          bytes: r.bytes,
          ms: r.durationMs,
          ttfbMs: r.ttfbMs,
          listingData: r.listingData,
          price: r.price.source ?? false,
          photos: r.photoCount,
          declaredPhotos: r.declaredPhotoCount,
          dpe: r.dpe,
          badTraffic: r.badTraffic,
          genericTitle: r.genericTitle,
          server: r.headers['server'] ?? null,
          cookies: r.cookieNames,
          signals: r.signals.map((s) => `${s.strength === 'strong' ? '!' : ''}${s.id}`),
          reasons: r.reasons,
          warnings: r.warnings,
        }),
      );
    });

    const meta = {
      probedAt: new Date(now).toISOString(),
      region,
      node: process.version,
      warnings,
      requestHeaders: requestHeaders(DEFAULT_CONFIG.userAgent),
      addedByNode: UNDICI_ADDED_HEADERS,
      rejected,
    };

    if (params.get('format') === 'md') {
      return new NextResponse(toMarkdown(results, meta), {
        headers: { ...NO_STORE, 'content-type': 'text/markdown; charset=utf-8' },
      });
    }
    return NextResponse.json(
      {
        ...meta,
        summary: results.map((r) => ({ platform: r.platform, release: r.release, verdict: r.verdict })),
        results,
      },
      { headers: NO_STORE },
    );
  } finally {
    running = false;
  }
}

export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { ...NO_STORE, allow: 'GET' } });
}
