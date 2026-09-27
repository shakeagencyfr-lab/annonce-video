import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ReadError, readSource } from '@/lib/readers';

const fixtures = join(__dirname, '../fixtures');
const AS24 = 'https://www.autoscout24.fr/offres/peugeot-308-1-2-puretech-130-allure-essence-gris-a1b2c3d4-0000-4000-8000-000000000001';
const tmp = mkdtempSync(join(tmpdir(), 'readers-'));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tmpFile(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content);
  return path;
}

async function failure(promise: Promise<unknown>): Promise<ReadError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReadError);
  return err as ReadError;
}

describe('readSource', () => {
  it('reads a Leboncoin export file', async () => {
    const { sheet, origin } = await readSource(join(fixtures, 'readers/leboncoin-auto-export.json'));
    expect(origin).toBe('export');
    expect(sheet).toMatchObject({ vertical: 'auto', platform: 'leboncoin', make: 'Peugeot' });
  });

  it('reads a sheet file', async () => {
    const { sheet, origin } = await readSource(`  ${join(fixtures, 'sheets/auto-308.json')}\n`);
    expect(origin).toBe('fiche');
    expect(sheet.sourceUrl).toBe('https://www.leboncoin.fr/ad/voitures/3209507340');
  });

  it('reads a sheet file saved with a byte order mark', async () => {
    const sheet = readFileSync(join(fixtures, 'sheets/auto-308.json'), 'utf8');
    const { origin } = await readSource(tmpFile('bom.json', `\uFEFF${sheet}`));
    expect(origin).toBe('fiche');
  });

  it('reads an AutoScout24 URL with the given fetch', async () => {
    const html = readFileSync(join(fixtures, 'readers/autoscout24-listing.html'), 'utf8');
    const fetch = vi.fn(async () => new Response(html));
    const { sheet, origin } = await readSource(AS24, { fetch });
    expect(origin).toBe('url');
    expect(sheet).toMatchObject({ platform: 'autoscout24-fr', make: 'Peugeot', price: 15990 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends a Leboncoin URL to the export instructions, without fetching', async () => {
    const fetch = vi.fn();
    const err = await failure(readSource('https://www.leboncoin.fr/ad/voitures/3209507340', { fetch }));
    expect(err.reason).toBe('server-read-blocked');
    expect(err.message).toMatch(/npm run bookmarklet/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists the supported inputs for an unknown URL or text', async () => {
    for (const input of ['https://www.seloger.com/annonce/achat/x/y/z/26ZCAGW19827', 'https://www.leboncoin.fr/recherche?category=2', 'annonce.json']) {
      const err = await failure(readSource(input));
      expect(err.reason).toBe('unsupported');
      expect(err.message).toMatch(/Entrées acceptées/);
      expect(err.message).toMatch(/AutoScout24\.fr/);
      expect(err.message).toMatch(/npm run bookmarklet/);
    }
  });

  it('refuses files that are not an export or a sheet', async () => {
    expect((await failure(readSource(tmpFile('broken.json', '{ pas du json')))).message).toMatch(/pas un JSON valide/);
    expect((await failure(readSource(tmpFile('other.json', '{"hello":"world"}')))).message).toMatch(/format inconnu/);
    const invalidSheet = await failure(readSource(tmpFile('sheet.json', '{"vertical":"auto","platform":"x"}')));
    expect(invalidSheet.reason).toBe('invalid-input');
    expect(invalidSheet.message).toMatch(/Fiche invalide/);
    const tampered = await failure(readSource(tmpFile('export.json', '{"source":"leboncoin","version":2}')));
    expect(tampered.message).toMatch(/fichier d’export invalide/);
  });
});
