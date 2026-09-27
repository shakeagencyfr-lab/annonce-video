import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

export const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

/** Per instance: enough to stop a loop of calls on a preview, not a real rate limit. */
const COOLDOWN_MS = 30_000;

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

/**
 * The response refusing this call, or null when the probe may run. The probes are
 * off unless PROBE_ENABLED is 1 (step 0 only). The caller only ever sees a 404; the
 * reason goes to the logs, never a value.
 */
export function refuse(req: NextRequest): NextResponse | null {
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
  return null;
}

/** Runs one probe at a time per instance and starts the cooldown. */
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  running = true;
  lastRunAt = Date.now();
  try {
    return await fn();
  } finally {
    running = false;
  }
}

export function headNotAllowed() {
  return new NextResponse(null, { status: 405, headers: { ...NO_STORE, allow: 'GET' } });
}
