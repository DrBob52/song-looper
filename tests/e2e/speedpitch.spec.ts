import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { decodeInBrowser, dragSelect, loadFixture, makeFixture, parseWav } from './helpers';

interface PlayerApi {
  getTime(): number;
  getAnalyser(): AnalyserNode;
  isPlaying(): boolean;
}

const playerTime = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { songLooper: { player: PlayerApi } }).songLooper.player.getTime());

/** Peak of the output signal over a short window, read from an analyser tapped at the master bus. */
async function outputPeak(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (duration) => {
    const player = (window as unknown as { songLooper: { player: PlayerApi } }).songLooper.player;
    const analyser = player.getAnalyser();
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const end = performance.now() + duration;
    while (performance.now() < end) {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      await new Promise((r) => setTimeout(r, 20));
    }
    return peak;
  }, ms);
}

test('speed and pitch change the preview live, reset restores it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);

  await page.getByTestId('speed').fill('1.25');
  await page.getByTestId('pitch-up').click();
  await page.getByTestId('pitch-up').click();
  await expect(page.getByTestId('speed-label')).toHaveText('1.25x');
  await expect(page.getByTestId('pitch-label')).toHaveText('+2');

  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.waitForTimeout(400);
  const t0 = await playerTime(page);
  const w0 = Date.now();
  const peak = await outputPeak(page, 1500);
  const t1 = await playerTime(page);
  const rate = (t1 - t0) / ((Date.now() - w0) / 1000);
  // the song advances 1.25x as fast as the wall clock while SoundTouch keeps producing sound
  expect(rate).toBeGreaterThan(1.1);
  expect(rate).toBeLessThan(1.4);
  expect(peak).toBeGreaterThan(0.01);

  // changing speed while playing keeps the position continuous and the new rate applies
  const before = await playerTime(page);
  await page.getByTestId('speed').fill('0.75');
  const after = await playerTime(page);
  expect(Math.abs(after - before)).toBeLessThan(0.3);
  const a0 = await playerTime(page);
  const aw = Date.now();
  await page.waitForTimeout(1200);
  const a1 = await playerTime(page);
  const slowRate = (a1 - a0) / ((Date.now() - aw) / 1000);
  expect(slowRate).toBeGreaterThan(0.6);
  expect(slowRate).toBeLessThan(0.9);

  // reset: neutral routing again (no worklet), still audible
  await page.getByTestId('speed-pitch-reset').click();
  await expect(page.getByTestId('speed-label')).toHaveText('1.00x');
  await expect(page.getByTestId('pitch-label')).toHaveText('0');
  await expect(page.getByTestId('speed-pitch-reset')).toBeDisabled();
  await page.waitForTimeout(300);
  const n0 = await playerTime(page);
  const nw = Date.now();
  expect(await outputPeak(page, 800)).toBeGreaterThan(0.01);
  const n1 = await playerTime(page);
  const normalRate = (n1 - n0) / ((Date.now() - nw) / 1000);
  expect(normalRate).toBeGreaterThan(0.9);
  expect(normalRate).toBeLessThan(1.1);
  await page.getByTestId('play').click();
  expect(errors).toEqual([]);
});

test('speed and pitch apply to a loop preview too', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await dragSelect(page, 0.2, 0.5);
  await page.keyboard.press('l');
  await page.getByTestId('pitch-down').click();
  await page.getByTestId('loop-preview').click();
  await expect(page.getByTestId('loop-preview')).toHaveText('Stop');
  expect(await outputPeak(page, 800)).toBeGreaterThan(0.01);
  await page.getByTestId('speed').fill('1.4'); // live change while previewing
  expect(await outputPeak(page, 600)).toBeGreaterThan(0.01);
  await page.getByTestId('loop-preview').click();
  await expect(page.getByTestId('loop-preview')).toHaveText('Loop');
  expect(errors).toEqual([]);
});

test('export can bake speed and pitch into the file, off by default', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'ABAB', barsPerSection: 4 });
  await loadFixture(page, fixture);

  // neutral: the checkbox is disabled
  await page.getByTestId('export').click();
  await expect(page.getByTestId('export-bake')).toBeDisabled();
  await page.getByTestId('export-cancel').click();

  await page.getByTestId('speed').fill('1.25');
  await page.getByTestId('pitch-up').click();
  await page.getByTestId('pitch-up').click();
  await page.getByTestId('pitch-up').click();

  await page.getByTestId('export').click();
  await expect(page.getByTestId('export-bake')).toBeEnabled();
  await expect(page.getByTestId('export-bake')).not.toBeChecked();
  const plainEstimate = await page.getByTestId('export-estimate').textContent();

  // unticked: original speed and pitch
  let [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const plain = readFileSync(await download.path());
  expect(Math.abs(parseWav(plain).duration - fixture.duration)).toBeLessThan(0.01);

  // ticked: 1.25x faster, +3 semitones
  await page.getByTestId('export').click();
  await page.getByTestId('export-bake').check();
  const bakedEstimate = await page.getByTestId('export-estimate').textContent();
  expect(bakedEstimate).not.toBe(plainEstimate);
  [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const baked = readFileSync(await download.path());
  const info = parseWav(baked);
  expect(info.riffSizeOk).toBe(true);
  expect(Math.abs(info.duration - fixture.duration / 1.25)).toBeLessThan(0.01);
  const decoded = await decodeInBrowser(page, baked);
  expect(Math.abs(decoded.duration - fixture.duration / 1.25)).toBeLessThan(0.02);
  expect(decoded.peak).toBeGreaterThan(0.1);
  expect(baked.equals(plain)).toBe(false);
});
