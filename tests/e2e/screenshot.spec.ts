import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { makeChordFixture, waitForAnalysis } from './helpers';

// Regenerates the README screenshots: SCREENSHOT=1 npx playwright test screenshot
//   docs/screenshot.png (light) and docs/screenshot-dark.png: desktop; docs/screenshot-phone.png and
//   docs/screenshot-phone-dark.png: 380 px wide.
// The pictures should show the real fonts. If the browser can't reach Google Fonts (a sandbox with an intercepting
// proxy, say), mirror them once and point FONTS_DIR at the folder:
//   curl -A "Mozilla/5.0 Chrome/141" "<the <link> href in index.html>" -o $FONTS_DIR/fonts.css
//   and every url(...) in it into the same folder, under its own file name.
test.skip(!process.env.SCREENSHOT, 'set SCREENSHOT=1 to regenerate the screenshots in docs/');

async function useRealFonts(context: BrowserContext): Promise<void> {
  const dir = process.env.FONTS_DIR;
  if (!dir || !existsSync(join(dir, 'fonts.css'))) return;
  await context.route(/fonts\.googleapis\.com\/css2/, (r) => r.fulfill({ path: join(dir, 'fonts.css'), contentType: 'text/css' }));
  await context.route(/fonts\.gstatic\.com\//, (r) =>
    r.fulfill({ path: join(dir, new URL(r.request().url()).pathname.split('/').pop()!), contentType: 'font/woff2' }),
  );
}

async function addLoop(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ([a, b]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({
        start: a!,
        end: b!,
      }),
    [start, end],
  );
}

/** A loaded song with its suggestions and two loops: loop 1 with a bridge, loop 2 rough with a cleaner loop suggested. */
async function setUp(page: Page): Promise<void> {
  // A chord-progression song (A = C G Am F, B = Dm Em F G, each bar one chord over a kick). The song goes F -> Dm and
  // G -> C, never F -> C, so a loop of A alone ends on a chord change the song never makes.
  const fixture = await makeChordFixture({ progressions: { A: 'C G Am F', B: 'Dm Em F G' }, structure: 'ABABABAB' }, 'demo-chords.wav');
  await page.goto('/');
  await page.setInputFiles('[data-testid=file-input]', { name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
  await page.waitForSelector('[data-testid=song-panel]:not([hidden])');
  await waitForAnalysis(page);
  // Loop 1 is the first A, with a bridge: four bars of the song after it, then back where G -> C is.
  await addLoop(page, 0, 8);
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/^Bridge: 4 bars/);
  await expect(page.getByTestId('seam-chip').first()).not.toHaveText('Rough');
  // Loop 2 stops one bar early (it ends on F and returns to C): the seam is rough and a cleaner loop is suggested.
  await addLoop(page, 16, 30);
  await expect(page.getByTestId('nearby').nth(1)).toBeVisible();
  await expect(page.getByTestId('seam-chip').nth(1)).toHaveText('Rough');
  await page.getByTestId('repeats').first().fill('3');
  await page.getByTestId('repeats').first().press('Enter');
  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('seam-summary').nth(1)).toBeVisible();
  await page.mouse.move(2, 2); // no row left hovered
  await page.waitForTimeout(800);
}

for (const scheme of ['light', 'dark'] as const) {
  const suffix = scheme === 'light' ? '' : '-dark';

  test(`take the ${scheme} desktop screenshot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
    await useRealFonts(context);
    const page = await context.newPage();
    await setUp(page);
    mkdirSync('docs', { recursive: true });
    // Grow the viewport to the page height so the sticky turntable bar sits at the bottom of the shot.
    await page.evaluate(() => window.scrollTo(0, 0));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1100, height: height + 24 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `docs/screenshot${suffix}.png` });
    await context.close();
  });

  test(`take the ${scheme} phone screenshot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 380, height: 760 }, colorScheme: scheme, deviceScaleFactor: 2 });
    await useRealFonts(context);
    const page = await context.newPage();
    await setUp(page);
    mkdirSync('docs', { recursive: true });
    // the first loop card and the turntable bar
    await page.locator('.region').first().scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('.region')!.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -12));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `docs/screenshot-phone${suffix}.png` });
    await context.close();
  });
}
