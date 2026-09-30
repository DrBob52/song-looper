import { mkdirSync } from 'node:fs';
import { test } from '@playwright/test';
import { loadFixture, makeFixture, waitForAnalysis } from './helpers';

// Regenerates docs/screenshot.png: SCREENSHOT=1 npx playwright test screenshot
test.skip(!process.env.SCREENSHOT, 'set SCREENSHOT=1 to regenerate docs/screenshot.png');

test('take the README screenshot', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 });
  const page = await context.newPage();
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 8, bpm: 120 }, 'demo-song.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const adds = page.getByTestId('suggestion-add');
  await adds.first().click();
  await adds.nth(2).click();
  await page.getByTestId('length-mode-target').check();
  await page.getByTestId('target-input').fill('6:00');
  await page.getByTestId('target-input').press('Enter');
  await page.getByTestId('mode-extended').click();
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
