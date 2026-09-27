import { NextResponse, type NextRequest } from 'next/server';
import { requestHeaders, UNDICI_ADDED_HEADERS } from '@/lib/probe/fetch';
import { exclusive, headNotAllowed, NO_STORE, refuse } from '@/lib/probe/guard';
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

export async function GET(req: NextRequest) {
  const refused = refuse(req);
  if (refused) return refused;

  return exclusive(async () => {
    const startedAt = new Date();
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
      probedAt: startedAt.toISOString(),
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
  });
}

export const HEAD = headNotAllowed;
