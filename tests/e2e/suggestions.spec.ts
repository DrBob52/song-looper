import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { appState, decodeInBrowser, loadFixture, makeFixture, parseWav, waitForAnalysis } from './helpers';

interface Cand {
  start: number;
  end: number;
  bars: number;
  score: number;
  reason: string;
}
interface Reg {
  start: number;
  end: number;
  repeats: number;
  score?: number;
}

test('suggestions list, hover highlight, preview, seam audition, add and export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);

  const rows = page.getByTestId('suggestion');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(4);
  expect(await rows.count()).toBeLessThanOrEqual(12);
  await expect(rows.first()).toContainText('Seam match');
  await expect(rows.first()).toContainText('bars');

  // section markers A, B, C are drawn on the waveform
  const labels = await page.evaluate(() => {
    const host = document.querySelector('[data-testid=waveform] > div');
    const root = host?.shadowRoot;
    if (!root) return '';
    return [...root.querySelectorAll('div')]
      .filter((d) => d.children.length === 0 && /^[A-Z]$/.test(d.textContent ?? ''))
      .map((d) => d.textContent)
      .join('');
  });
  expect(labels).toBe('ABABCA');

  // sorted by score, best first
  const cands = await appState<Cand[]>(page, 's.analysis.candidates');
  for (let i = 1; i < cands.length; i++) expect(cands[i - 1]!.score).toBeGreaterThanOrEqual(cands[i]!.score);

  // hovering a row highlights its span on the waveform
  await rows.nth(1).hover();
  await expect(page.locator('[data-region-id=highlight]')).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(page.locator('[data-region-id=highlight]')).toHaveCount(0);

  // preview toggles, audition plays and can be stopped
  await rows.first().getByTestId('suggestion-preview').click();
  await expect(rows.first().getByTestId('suggestion-preview')).toHaveText('Stop');
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await rows.first().getByTestId('suggestion-preview').click();
  await expect(rows.first().getByTestId('suggestion-preview')).toHaveText('Preview');
  await rows.first().getByTestId('suggestion-seam').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');

  // add the top suggestion, set repeats to 3, export and check the length
  await rows.first().getByTestId('suggestion-add').click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await expect(rows.first().getByTestId('suggestion-add')).toHaveText('Added');
  const repeats = page.getByTestId('repeats');
  await repeats.fill('3');
  await repeats.press('Enter');
  const [region] = await appState<Reg[]>(page, 's.regions');
  expect(region!.start).toBeCloseTo(cands[0]!.start, 3);
  expect(region!.end).toBeCloseTo(cands[0]!.end, 3);
  expect(region!.score).toBeCloseTo(cands[0]!.score, 6);
  const expected = fixture.duration + 2 * (region!.end - region!.start);

  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const wav = readFileSync(await download.path());
  const info = parseWav(wav);
  expect(Math.abs(info.duration - expected)).toBeLessThan(0.02);
  const decoded = await decodeInBrowser(page, wav);
  expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
  expect(decoded.peak).toBeGreaterThan(0.2);
  expect(errors).toEqual([]);
});

test('a very short song skips suggestions', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 2 }); // ~8.5 s
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(page.getByTestId('suggestions-note')).toContainText('under 20 seconds');
  await expect(page.getByTestId('suggestion')).toHaveCount(0);
});
