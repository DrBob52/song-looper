import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Real fonts for tests and screenshots in a sandbox whose browser cannot reach Google Fonts (an intercepting proxy, say)
 * but whose curl can. Mirror them once, then point FONTS_DIR at the folder:
 *
 *   npx tsx scripts/mirror-fonts.ts /path/to/fonts
 *   FONTS_DIR=/path/to/fonts SCREENSHOT=1 npx playwright test screenshot
 *   FONTS_DIR=/path/to/fonts npx playwright test layout-fonts
 *
 * The folder holds manifest.json (stylesheet URL -> .css file) and every font file under its own name. A folder from
 * before skins (just fonts.css for the <link> in index.html) still works for Vinyl.
 */
export function fontsDir(): string | null {
  const dir = process.env.FONTS_DIR;
  return dir && (existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, 'fonts.css'))) ? dir : null;
}

function manifestOf(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (existsSync(join(dir, 'manifest.json'))) {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, string>;
    for (const [url, file] of Object.entries(raw)) map.set(new URL(url).href, join(dir, file));
  }
  return map;
}

/** Answer the browser's Google Fonts requests from the mirrored folder. Returns false when there is no folder. */
export async function useRealFonts(target: BrowserContext | Page): Promise<boolean> {
  const dir = fontsDir();
  if (!dir) return false;
  const sheets = manifestOf(dir);
  const cors = { 'access-control-allow-origin': '*' };
  await target.route(/fonts\.googleapis\.com\/css2/, (r) => {
    const file = sheets.get(new URL(r.request().url()).href) ?? (existsSync(join(dir, 'fonts.css')) ? join(dir, 'fonts.css') : null);
    return file ? r.fulfill({ path: file, contentType: 'text/css', headers: cors }) : r.abort();
  });
  await target.route(/fonts\.gstatic\.com\//, (r) => {
    const file = join(dir, basename(new URL(r.request().url()).pathname));
    return existsSync(file) ? r.fulfill({ path: file, contentType: 'font/woff2', headers: cors }) : r.abort();
  });
  return true;
}

/** The faces the page has actually loaded, by family (what the screenshots and the real-fonts check report). */
export async function loadedFamilies(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))].sort());
}
