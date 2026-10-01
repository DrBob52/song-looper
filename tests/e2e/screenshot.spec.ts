import { mkdirSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { loadFixture, makeChordFixture, waitForAnalysis } from './helpers';

// Regenerates docs/screenshot.png: SCREENSHOT=1 npx playwright test screenshot
test.skip(!process.env.SCREENSHOT, 'set SCREENSHOT=1 to regenerate docs/screenshot.png');

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

test('take the README screenshot', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 });
  const page = await context.newPage();
  // A chord-progression song (A = C G Am F, B = Dm Em F G, each bar one chord over a kick). The song goes F -> Dm and
  // G -> C, never F -> C, so a loop of A alone ends on a chord change the song never makes.
  const fixture = await makeChordFixture(
    { progressions: { A: 'C G Am F', B: 'Dm Em F G' }, structure: 'ABABABAB' },
    'demo-chords.wav',
  );
  await loadFixture(page, fixture);
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
  await page.waitForTimeout(800);
  mkdirSync('docs', { recursive: true });
  // Grow the viewport to the page height so the sticky transport bar sits at the bottom of the shot.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1100, height: height + 24 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/screenshot.png' });
  await context.close();
});
