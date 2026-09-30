import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { decodeInBrowser, dragSelect, loadFixture, makeFixture, parseWav } from './helpers';

interface Region {
  start: number;
  end: number;
  repeats: number;
}

async function regions(page: Page): Promise<Region[]> {
  return page.evaluate(
    () =>
      (window as unknown as { songLooper: { store: { get(): { regions: Region[] } } } }).songLooper.store.get().regions,
  );
}

async function exportWav(page: Page, depthTestId?: string): Promise<Buffer> {
  await page.getByTestId('export').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  if (depthTestId) await page.getByTestId(depthTestId).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-confirm').click(),
  ]);
  const path = await download.path();
  expect(download.suggestedFilename()).toMatch(/\(extended\)\.wav$/);
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  return readFileSync(path);
}

test('select, add a loop, repeat it 3x, export and verify the WAV', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 4 });
  await loadFixture(page, fixture);

  await dragSelect(page, 0.2, 0.55);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);

  // Set repeats to 3
  const repeats = page.getByTestId('repeats');
  await repeats.fill('3');
  await repeats.press('Enter');
  await expect(repeats).toHaveValue('3');

  const [region] = await regions(page);
  expect(region).toBeTruthy();
  expect(region!.repeats).toBe(3);
  const regionLen = region!.end - region!.start;
  expect(regionLen).toBeGreaterThan(3);
  const expected = fixture.duration + 2 * regionLen;

  await expect(page.getByTestId('length-extended')).toContainText(
    `${Math.floor(expected / 60)}:${String(Math.floor(expected % 60)).padStart(2, '0')}`,
  );

  const wav = await exportWav(page);
  const info = parseWav(wav);
  expect(info.format).toBe(1);
  expect(info.channels).toBe(2);
  expect(info.sampleRate).toBe(44100);
  expect(info.bitsPerSample).toBe(16);
  expect(info.riffSizeOk).toBe(true);
  // Zero-crossing snapping moves each region edge by at most ~2 ms
  expect(Math.abs(info.duration - expected)).toBeLessThan(0.02);

  const decoded = await decodeInBrowser(page, wav);
  expect(decoded.channels).toBe(2);
  expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
  expect(decoded.peak).toBeGreaterThan(0.2);

  expect(errors).toEqual([]);
});

test('exports 24-bit and 32-bit float files that decode', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 2 });
  await loadFixture(page, fixture);
  await dragSelect(page, 0.1, 0.5);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  const [region] = await regions(page);
  const expected = fixture.duration + (region!.repeats - 1) * (region!.end - region!.start);

  for (const [testId, bits, format] of [
    ['depth-24', 24, 1],
    ['depth-32', 32, 3],
  ] as const) {
    const wav = await exportWav(page, testId);
    const info = parseWav(wav);
    expect(info.bitsPerSample).toBe(bits);
    expect(info.format).toBe(format);
    expect(Math.abs(info.duration - expected)).toBeLessThan(0.02);
    const decoded = await decodeInBrowser(page, wav);
    expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
    expect(decoded.peak).toBeGreaterThan(0.2);
  }
});

test('extended preview plays and seam audition runs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await dragSelect(page, 0.25, 0.6);
  await page.keyboard.press('l');
  await page.getByTestId('repeats-inc').click(); // 2 -> 3
  const [region] = await regions(page);
  const expected = fixture.duration + (region!.repeats - 1) * (region!.end - region!.start);

  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('render-status')).toHaveText('');
  await expect(page.getByTestId('time')).toContainText(`/ ${Math.floor(expected / 60)}:${(expected % 60).toFixed(1).padStart(4, '0')}`);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('time')).not.toContainText('0:00.0 /');
  await page.getByTestId('play').click();

  await page.getByTestId('audition-seam').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click(); // stops the audition
  await expect(page.getByTestId('play')).toHaveText('Play');

  await page.getByTestId('loop-preview').click();
  await expect(page.getByTestId('loop-preview')).toHaveText('Stop');
  await page.getByTestId('loop-preview').click();
  await expect(page.getByTestId('loop-preview')).toHaveText('Loop');
  expect(errors).toEqual([]);
});

test('loops cannot overlap: refused, clamped or pushed back; Delete removes the selected loop', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await dragSelect(page, 0.4, 0.6);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  const [first] = await regions(page);

  // A span fully inside the first loop is refused.
  await page.evaluate(
    ([a, b]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): void } }).songLooper.addLoop({
        start: a!,
        end: b!,
      }),
    [first!.start + 1, first!.end - 1],
  );
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await expect(page.getByTestId('notice')).toContainText('overlaps');

  // A selection that runs into the first loop is clamped to the free space before it.
  await dragSelect(page, 0.05, 0.5);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(2);
  let rs = await regions(page);
  expect(rs[0]!.end).toBeLessThanOrEqual(rs[1]!.start + 1e-9);
  expect(rs[0]!.end).toBeCloseTo(first!.start, 3);

  // Dragging the first loop across the second one stops at the neighbour instead of overlapping.
  const box = await page.getByTestId('waveform').boundingBox();
  const y = box!.y + box!.height / 2;
  const fromX = box!.x + box!.width * ((rs[0]!.start + rs[0]!.end) / 2 / fixture.duration);
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(fromX + (box!.width * 0.9 * i) / 20, y);
  await page.mouse.up();
  rs = await regions(page);
  expect(rs).toHaveLength(2);
  expect(rs[0]!.end).toBeLessThanOrEqual(rs[1]!.start + 1e-9);

  await page.keyboard.press('Delete'); // removes the selected loop
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
});
