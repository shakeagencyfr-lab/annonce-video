import { NextResponse, type NextRequest } from 'next/server';
import { exclusive, headNotAllowed, NO_STORE, refuse } from '@/lib/probe/guard';
import { imagesToMarkdown, probeImages, resolveImageTargets } from '@/lib/probe/images';
import { DEFAULT_CONFIG } from '@/lib/probe/run';

// Step 0 bis: can Vercel download listing photos from the platforms' image hosts?
// Same guard as /api/probe. One photo per platform, plus one missing-object control.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 120;

const BUDGET_MS = 105_000;
const EXPECTED_REGION = 'cdg1';
/** Photos are downloaded in full up to this size, then only their first bytes are kept. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const refused = refuse(req);
  if (refused) return refused;

  return exclusive(async () => {
    const startedAt = new Date();
    const params = req.nextUrl.searchParams;
    const groupFilter = params
      .getAll('platform')
      .flatMap((p) => p.split(','))
      .map((p) => p.trim())
      .filter(Boolean);
    const { targets, rejected } = resolveImageTargets(params.getAll('img'), groupFilter);

    const region = process.env.VERCEL_REGION ?? 'local';
    const warnings =
      region === EXPECTED_REGION
        ? []
        : [`région ${region} au lieu de ${EXPECTED_REGION} : le résultat ne vaut pas pour la production à Paris`];

    // Derived facts only, never image or page content.
    const results = await probeImages(targets, { ...DEFAULT_CONFIG, maxBytes: MAX_IMAGE_BYTES }, BUDGET_MS, (r) => {
      const brief = (p: typeof r.image) =>
        p && {
          url: p.url,
          source: p.source,
          status: p.status,
          format: p.format,
          contentType: p.contentType,
          bytes: p.bytes,
          ms: p.durationMs,
          server: p.server,
          cache: p.cache,
          signals: p.signals.map((s) => `${s.strength === 'strong' ? '!' : ''}${s.id}`),
          verdict: p.verdict,
          reasons: p.reasons,
        };
      console.info(
        JSON.stringify({
          images: r.group,
          region,
          verdict: r.verdict,
          reasons: r.reasons,
          attempts: r.attempts.map(brief),
          control: brief(r.control),
        }),
      );
    });

    const meta = { probedAt: startedAt.toISOString(), region, node: process.version, warnings, rejected };
    if (params.get('format') === 'md') {
      return new NextResponse(imagesToMarkdown(results, meta), {
        headers: { ...NO_STORE, 'content-type': 'text/markdown; charset=utf-8' },
      });
    }
    return NextResponse.json(
      { ...meta, summary: results.map((r) => ({ platform: r.group, verdict: r.verdict })), results },
      { headers: NO_STORE },
    );
  });
}

export const HEAD = headNotAllowed;
