/**
 * Mirror the Google Fonts stylesheets and font files of every look into a folder, for screenshots and the real-fonts
 * layout check on a machine whose browser cannot reach Google Fonts (a sandbox with an intercepting proxy, say) but whose
 * curl can:
 *
 *   npx tsx scripts/mirror-fonts.ts /path/to/fonts            then
 *   FONTS_DIR=/path/to/fonts SCREENSHOT=1 npx playwright test screenshot
 *   FONTS_DIR=/path/to/fonts npx playwright test layout-fonts
 *
 * It writes manifest.json (stylesheet URL -> file), one .css per stylesheet, and every font file under its own name
 * (the tests answer the browser's request for https://fonts.gstatic.com/.../name.woff2 with that file).
 * Uses a Chrome user agent, so that Google serves woff2.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKINS } from '../src/ui/skins';

const dir = process.argv[2] ?? process.env.FONTS_DIR;
if (!dir) {
  console.error('usage: npx tsx scripts/mirror-fonts.ts <folder>');
  process.exit(1);
}
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const curl = (url: string): Buffer => execFileSync('curl', ['-sS', '--fail', '--max-time', '60', '-A', UA, url], { maxBuffer: 64 * 1024 * 1024 });

// Vinyl's fonts are the <link> in index.html; the other looks' are in src/ui/skins.ts
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const vinyl = /href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/.exec(index)?.[1]?.replace(/&amp;/g, '&');
const urls = [...(vinyl ? [vinyl] : []), ...SKINS.flatMap((s) => (s.fonts ? [s.fonts] : []))];

mkdirSync(dir, { recursive: true });
const manifest: Record<string, string> = {};
let files = 0;
urls.forEach((url, i) => {
  const css = curl(url).toString('utf8');
  const name = `css-${i + 1}.css`;
  writeFileSync(join(dir, name), css);
  manifest[url] = name;
  for (const m of css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) {
    const file = new URL(m[1]!).pathname.split('/').pop()!;
    writeFileSync(join(dir, file), curl(m[1]!));
    files++;
  }
});
writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${urls.length} stylesheets and ${files} font files in ${dir}`);
