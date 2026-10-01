import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
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

// SPEC-v1.3.md 7.3: the card is collapsible, with a count in its toggle, and the choice is remembered.

test('the Suggested loops toggle shows the count, collapses the card to its header, and the choice survives a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const cands = await appState<Cand[]>(page, 's.analysis.candidates');
  const toggle = page.getByTestId('suggestions-toggle');
  const card = page.getByTestId('suggestions');
  await expect(toggle).toHaveText(`Suggested loops (${cands.length})`);
  // open by default; the toggle names the region it controls
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const controls = await toggle.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  expect(await page.evaluate((id) => document.getElementById(id!)?.contains(document.querySelector('[data-testid=suggestion]')), controls)).toBe(true);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  const openHeight = (await card.boundingBox())!.height;

  // collapsed: only the header, none of the rows or buttons
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText(`Suggested loops (${cands.length})`);
  await expect(page.getByTestId('suggestion').first()).toBeHidden();
  await expect(page.getByTestId('suggestions-more')).toBeHidden();
  await expect(page.getByTestId('suggestion-add').first()).toBeHidden();
  const closedHeight = (await card.boundingBox())!.height;
  expect(closedHeight).toBeLessThan(80);
  expect(closedHeight).toBeLessThan(openHeight / 3);
  expect(await page.evaluate(() => localStorage.getItem('song-looper-suggestions-open'))).toBe('0');

  // remembered: a fresh page load comes up collapsed, with the same count
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText(`Suggested loops (${cands.length})`);
  await expect(page.getByTestId('suggestion').first()).toBeHidden();

  // the keyboard works: Enter and Space on the focused toggle
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => localStorage.getItem('song-looper-suggestions-open'))).toBe('1');
  // everything in the list still works after the card was closed and opened: add the first one
  await page.getByTestId('suggestion-add').first().click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await expect(page.getByTestId('suggestion-add').first()).toHaveText('Added');
  // opening again after a reload comes up open
  await loadFixture(page, fixture);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('while the song is analysed the toggle reads Finding loops… and still works; the count arrives afterwards', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 16 });
  await loadFixture(page, fixture);
  const toggle = page.getByTestId('suggestions-toggle');
  await expect(toggle).toHaveText('Finding loops…');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('suggestions-note')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveText('Finding loops…');
  await waitForAnalysis(page);
  await expect(toggle).toHaveText(/^Suggested loops \(\d+\)$/);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
});

test('with storage blocked the card is open and the toggle still works', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const toggle = page.getByTestId('suggestions-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('suggestion').first()).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  expect(errors).toEqual([]);
});
