import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { appState, decodeInBrowser, dragSelect, loadFixture, makeFixture, parseWav, waitForAnalysis } from './helpers';

interface Reg {
  start: number;
  end: number;
  repeats: number;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

test('several loops, target length mode and the extended timeline strip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);

  // two loops from the suggestions list and by hand
  const rows = page.getByTestId('suggestion');
  await rows.first().getByTestId('suggestion-add').click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await page.getByTestId('waveform').scrollIntoViewIfNeeded();
  const first = (await appState<Reg[]>(page, 's.regions'))[0]!;
  // pick a free span away from the first loop (first is ~8-24 s of 48.5 s)
  await dragSelect(page, 0.66, 0.9);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(2);
  let regions = await appState<Reg[]>(page, 's.regions');
  expect(regions[0]!.end).toBeLessThanOrEqual(regions[1]!.start + 1e-9);
  expect(regions[0]!.start).toBeCloseTo(first.start, 6);
  const shortest = Math.min(...regions.map((r) => r.end - r.start));

  // target length mode
  await page.getByTestId('length-mode-target').check();
  const target = 120;
  await page.getByTestId('target-input').fill(mmss(target));
  await page.getByTestId('target-input').press('Enter');
  await expect(page.getByTestId('length-note')).toContainText('Closest whole repeats');
  regions = await appState<Reg[]>(page, 's.regions');
  const ext = fixture.duration + regions.reduce((s, r) => s + (r.repeats - 1) * (r.end - r.start), 0);
  expect(Math.abs(ext - target)).toBeLessThanOrEqual(shortest / 2 + 0.05);
  expect(regions.every((r) => r.repeats >= 1)).toBe(true);
  expect(regions.some((r) => r.repeats > 1)).toBe(true);
  // the actual length is displayed
  await expect(page.getByTestId('length-extended')).toHaveText(mmss(ext));
  // repeat steppers are read-only in this mode
  await expect(page.getByTestId('repeats').first()).toBeDisabled();

  // a shorter target than the song: nothing repeats
  await page.getByTestId('target-input').fill('0:20');
  await page.getByTestId('target-input').press('Enter');
  await expect(page.getByTestId('length-note')).toContainText('nothing repeats');
  expect((await appState<Reg[]>(page, 's.regions')).every((r) => r.repeats === 1)).toBe(true);
  await page.getByTestId('target-input').fill(mmss(target));
  await page.getByTestId('target-input').press('Enter');

  // an invalid entry is flagged and ignored
  await page.getByTestId('target-input').fill('soon');
  await page.getByTestId('target-input').press('Enter');
  await expect(page.getByTestId('target-input')).toHaveAttribute('aria-invalid', 'true');

  // the strip shows one block per segment; original + repeats
  const blocks = await page.locator('[data-testid=timeline] .tl-block').count();
  const repeatBlocks = await page.locator('[data-testid=timeline] .tl-block.repeat').count();
  expect(repeatBlocks).toBe(regions.reduce((s, r) => s + r.repeats, 0));
  expect(blocks).toBeGreaterThan(repeatBlocks);

  // clicking the strip switches to the extended preview and seeks there
  const tl = await page.getByTestId('timeline').boundingBox();
  await page.mouse.click(tl!.x + tl!.width * 0.5, tl!.y + tl!.height / 2);
  await expect(page.getByTestId('mode-extended')).toHaveClass(/active/);
  await expect(page.getByTestId('render-status')).toHaveText('');
  await expect.poll(async () => (await page.getByTestId('time').textContent()) ?? '').toContain(`/ ${Math.floor(ext / 60)}:`);
  const t = await page.evaluate(
    () => (window as unknown as { songLooper: { player: { getTime(): number } } }).songLooper.player.getTime(),
  );
  expect(Math.abs(t - ext / 2)).toBeLessThan(ext * 0.03);

  // export: length equals the displayed extended length
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const wav = readFileSync(await download.path());
  expect(Math.abs(parseWav(wav).duration - ext)).toBeLessThan(0.03);
  const decoded = await decodeInBrowser(page, wav);
  expect(Math.abs(decoded.duration - ext)).toBeLessThan(0.03);

  // seam smoothing is exposed under Advanced and changes the render settings
  await page.locator('summary', { hasText: 'Advanced' }).click();
  await page.getByTestId('seam-smoothing').fill('40');
  expect(await appState<number>(page, 's.seamMs')).toBe(40);
  expect(errors).toEqual([]);
});
