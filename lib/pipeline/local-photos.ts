import { copyFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import type { LocalPhoto } from './types';

const FORMATS = new Set<LocalPhoto['format']>(['jpeg', 'png', 'webp', 'avif', 'gif']);

/**
 * Photos taken from a local folder instead of the listing (offline mode and tests),
 * sorted by file name and copied into the render's public folder.
 */
export async function loadLocalPhotos(sourceDir: string, publicDir: string, max = 20): Promise<LocalPhoto[]> {
  const names = (await readdir(sourceDir)).filter((n) => /\.(jpe?g|png|webp|avif|gif)$/i.test(n)).sort();
  const photos: LocalPhoto[] = [];
  for (const [index, name] of names.slice(0, max).entries()) {
    const source = resolve(sourceDir, name);
    const meta = await sharp(source).metadata();
    const format = meta.format as LocalPhoto['format'] | undefined;
    if (!meta.width || !meta.height || !format || !FORMATS.has(format)) continue;
    const path = join(publicDir, `photo-${index}${extname(name).toLowerCase()}`);
    await copyFile(source, path);
    photos.push({
      index,
      sourceUrl: pathToFileURL(source).href,
      path,
      width: meta.width,
      height: meta.height,
      bytes: meta.size ?? 0,
      format,
    });
  }
  return photos;
}
