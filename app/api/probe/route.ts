import { NextResponse, type NextRequest } from 'next/server';
import { toMarkdown } from '@/lib/probe/report';
import { DEFAULT_CONFIG, probeAll, resolveTargets } from '@/lib/probe/run';

// Step 0: can Vercel read one listing per platform? Preview only.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'cdg1';
export const maxDuration = 120;

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

export async function GET(req: NextRequest) {
  if (process.env.VERCEL_ENV === 'production' && process.env.PROBE_ENABLED !== '1') {
    return new NextResponse('Not found', { status: 404, headers: NO_STORE });
  }

  const params = req.nextUrl.searchParams;
  const platformFilter = params
    .getAll('platform')
    .flatMap((p) => p.split(','))
    .map((p) => p.trim())
    .filter(Boolean);
  const { targets, rejected } = resolveTargets(params.getAll('url'), platformFilter);

  const probedAt = new Date().toISOString();
  const region = process.env.VERCEL_REGION ?? 'local';
  const results = await probeAll(targets, DEFAULT_CONFIG);

  for (const r of results) {
    console.info(
      JSON.stringify({
        probe: r.platform,
        region,
        status: r.status,
        verdict: r.verdict,
        bytes: r.bytes,
        ms: r.durationMs,
        signals: r.signals.map((s) => s.id),
      }),
    );
  }

  if (params.get('format') === 'md') {
    return new NextResponse(toMarkdown(results, { probedAt, region, rejected }), {
      headers: { ...NO_STORE, 'content-type': 'text/markdown; charset=utf-8' },
    });
  }

  return NextResponse.json(
    {
      probedAt,
      region,
      userAgent: DEFAULT_CONFIG.userAgent,
      summary: results.map((r) => ({ platform: r.platform, release: r.release, verdict: r.verdict })),
      rejected,
      results,
    },
    { headers: NO_STORE },
  );
}
