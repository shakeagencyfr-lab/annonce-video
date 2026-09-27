import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/probe/route');
}

const request = (query = '', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/probe${query}`, { headers });

describe('GET /api/probe', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('blocked', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers 404 and fetches nothing unless PROBE_ENABLED=1, whatever VERCEL_ENV says', async () => {
    for (const env of ['preview', 'development', 'production', '']) {
      vi.stubEnv('VERCEL_ENV', env);
      vi.stubEnv('PROBE_ENABLED', '');
      const { GET } = await loadRoute();
      expect((await GET(request())).status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires the token header when PROBE_TOKEN is set', async () => {
    vi.stubEnv('PROBE_ENABLED', '1');
    vi.stubEnv('PROBE_TOKEN', 'secret-token');
    const { GET } = await loadRoute();
    expect((await GET(request('?platform=pap', { 'x-probe-token': 'wrong' }))).status).toBe(404);
    expect((await GET(request('?platform=pap'))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await GET(request('?platform=pap', { 'x-probe-token': 'secret-token' }))).status).toBe(200);
  });

  it('probes, flags a region other than cdg1, and refuses a second call during the cooldown', async () => {
    vi.stubEnv('PROBE_ENABLED', '1');
    vi.stubEnv('VERCEL_REGION', 'iad1');
    const { GET } = await loadRoute();
    const res = await GET(request('?platform=pap'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual([{ platform: 'pap', release: 'V1.1', verdict: 'bloqué' }]);
    expect(body.warnings[0]).toContain('iad1');
    expect(body.addedByNode).toContain('sec-fetch-mode: cors');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const again = await GET(request('?platform=pap'));
    expect(again.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders the Markdown table', async () => {
    vi.stubEnv('PROBE_ENABLED', '1');
    vi.stubEnv('VERCEL_REGION', 'cdg1');
    const { GET } = await loadRoute();
    const res = await GET(request('?platform=lacentrale&format=md&url=https://example.com/x'));
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(text).toContain('| La Centrale | auto | V1.1 | 403 |');
    expect(text).toContain('**bloqué**');
    expect(text).not.toContain('⚠ région');
    expect(text).toContain('https://example.com/x');
  });

  it('answers 405 to HEAD without probing', async () => {
    vi.stubEnv('PROBE_ENABLED', '1');
    const { HEAD } = await loadRoute();
    expect(HEAD().status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
