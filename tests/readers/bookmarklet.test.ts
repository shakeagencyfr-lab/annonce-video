import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { fromExport } from '@/lib/readers/leboncoin';

const root = join(__dirname, '../..');
const source = readFileSync(join(root, 'tools/leboncoin-export.js'), 'utf8');
const ad = JSON.parse(readFileSync(join(root, 'tests/fixtures/readers/leboncoin-auto-export.json'), 'utf8')).ad;
const AD_URL = 'https://www.leboncoin.fr/ad/voitures/3209507340';

type Page = { href: string; nextData?: string };

/** Runs the script against a minimal fake DOM and records what it did. */
function run(code: string, page: Page) {
  const url = new URL(page.href);
  const alerts: string[] = [];
  const downloads: { name: string; type: string; content: string }[] = [];
  const blobs = new Map<string, { type: string; content: string }>();
  const revoked: string[] = [];
  const attached = new Set<unknown>();

  class FakeBlob {
    constructor(
      readonly parts: string[],
      readonly options: { type: string },
    ) {}
  }
  const document = {
    getElementById: (id: string) => (id === '__NEXT_DATA__' && page.nextData !== undefined ? { textContent: page.nextData } : null),
    createElement: (tag: string) => {
      const el = {
        tagName: tag.toUpperCase(),
        href: '',
        download: '',
        click() {
          expect(attached.has(el)).toBe(true);
          const blob = blobs.get(el.href);
          if (blob) downloads.push({ name: el.download, ...blob });
        },
      };
      return el;
    },
    body: {
      appendChild: (node: unknown) => attached.add(node),
      removeChild: (node: unknown) => attached.delete(node),
    },
  };
  let n = 0;
  const context = vm.createContext({
    location: { href: page.href, protocol: url.protocol, hostname: url.hostname, pathname: url.pathname, origin: url.origin },
    document,
    Blob: FakeBlob,
    URL: {
      createObjectURL: (blob: FakeBlob) => {
        const id = `blob:https://www.leboncoin.fr/${++n}`;
        blobs.set(id, { type: blob.options.type, content: blob.parts.join('') });
        return id;
      },
      revokeObjectURL: (id: string) => revoked.push(id),
    },
    alert: (message: string) => alerts.push(message),
    setTimeout: (fn: () => void) => fn(),
  });
  vm.runInContext(code, context);
  return { alerts, downloads, revoked, attached };
}

const nextData = (pageAd: unknown) => JSON.stringify({ props: { pageProps: { ad: pageAd } }, page: '/ad/[cat]/[id]' });

function expectExport(result: ReturnType<typeof run>) {
  expect(result.alerts).toEqual([]);
  expect(result.downloads).toHaveLength(1);
  const [download] = result.downloads;
  expect(download?.name).toBe('leboncoin-3209507340.json');
  expect(download?.type).toBe('application/json');
  const exported = JSON.parse(download?.content ?? '');
  expect(exported).toEqual({
    source: 'leboncoin',
    version: 1,
    url: AD_URL,
    exportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    ad,
  });
  expect(result.revoked).toHaveLength(1);
  expect(result.attached.size).toBe(0);
  // What it downloads is what make-video reads.
  expect(fromExport(exported)).toMatchObject({ vertical: 'auto', sourceUrl: AD_URL, make: 'Peugeot' });
}

describe('leboncoin-export.js', () => {
  it('is plain ES5', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\./);
  });

  it('exports the ad of the page displayed, without query string nor fragment in its URL', () => {
    expectExport(run(source, { href: `${AD_URL}?utm_source=share#photos`, nextData: nextData(ad) }));
  });

  it('refuses other pages with a French message', () => {
    for (const href of ['https://www.leboncoin.fr/recherche?category=2', 'https://www.autoscout24.fr/offres/x', 'http://www.leboncoin.fr/ad/voitures/3209507340']) {
      const result = run(source, { href, nextData: nextData(ad) });
      expect(result.downloads).toEqual([]);
      expect(result.alerts).toEqual([expect.stringMatching(/ouvrez d’abord la page de votre annonce/)]);
    }
  });

  it('refuses a page whose data is missing or about another ad', () => {
    for (const data of [undefined, '{ cassé', nextData(null), nextData({ ...ad, list_id: 3209507341 })]) {
      const result = run(source, { href: AD_URL, nextData: data });
      expect(result.downloads).toEqual([]);
      expect(result.alerts).toEqual([expect.stringMatching(/introuvables dans la page\. Rechargez la page/)]);
    }
  });
});

describe('print-bookmarklet', () => {
  const output = execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'scripts/print-bookmarklet.ts')], {
    cwd: root,
    encoding: 'utf8',
  });
  const line = output.split('\n').find((l) => l.startsWith('javascript:')) ?? '';

  it('prints French instructions and a one-line javascript: URL', () => {
    expect(output).toMatch(/Favori d’export Leboncoin/);
    expect(output).toMatch(/npm run make-video/);
    expect(line).toMatch(/^javascript:[^\s]+$/);
  });

  it('prints a bookmarklet that behaves like the source', () => {
    const code = decodeURIComponent(line.slice('javascript:'.length));
    expect(code).not.toMatch(/\n|\/\*/);
    expectExport(run(code, { href: AD_URL, nextData: nextData(ad) }));
    expect(run(code, { href: 'https://www.leboncoin.fr/', nextData: nextData(ad) }).alerts).toHaveLength(1);
  });
});
