import { expect, test } from '@playwright/test';
import { appState, dragSelect, loadFixture, makeFixture, waitForAnalysis } from './helpers';

interface Reg {
  start: number;
  end: number;
}

test('analysis finds tempo and beats, draws a grid, and selections snap to bar lines', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);

  const bpm = await appState<number>(page, 's.analysis.bpm');
  expect(Math.abs(bpm - 120)).toBeLessThan(1);
  await expect(page.getByTestId('tempo-select')).toContainText('120');
  await expect(page.getByTestId('meter-select')).toHaveValue('4');
  await expect(page.getByTestId('analysis-message')).toBeHidden();

  // beat and bar lines are drawn inside the waveform
  const lines = await page.evaluate(() => {
    const host = document.querySelector('[data-testid=waveform] > div');
    return host?.shadowRoot?.querySelectorAll('svg line').length ?? 0;
  });
  expect(lines).toBeGreaterThan(80);

  // a dragged selection snaps to bars
  await dragSelect(page, 0.23, 0.61);
  await page.keyboard.press('l');
  const [region] = await appState<Reg[]>(page, 's.regions');
  const bars = await appState<number[]>(page, 's.grid.bars');
  const near = (t: number): number => Math.min(...bars.map((b) => Math.abs(b - t)));
  expect(near(region!.start)).toBeLessThan(1e-6);
  expect(near(region!.end)).toBeLessThan(1e-6);
  const barSeconds = await appState<number>(page, 's.grid.barSeconds');
  expect((region!.end - region!.start) / barSeconds).toBeGreaterThanOrEqual(1);
  // the regions list shows the length in bars
  await expect(page.getByTestId('regions')).toContainText('bar');
  expect(errors).toEqual([]);
});

test('snap can switch to beats, and Shift-drag turns snapping off', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await dragSelect(page, 0.2, 0.5);
  await page.keyboard.press('l');
  await page.getByTestId('snap-toggle').uncheck();
  await page.getByTestId('waveform').scrollIntoViewIfNeeded();

  const beats = await appState<number[]>(page, 's.grid.beats');
  const bars = await appState<number[]>(page, 's.grid.bars');
  const dist = (arr: number[], t: number): number => Math.min(...arr.map((b) => Math.abs(b - t)));

  // drag the right edge handle a little: lands on a beat, not necessarily a bar
  const handle = page.locator('[part~="region-handle-right"]').first();
  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 5 });
  await page.mouse.move(x + 21, y, { steps: 5 });
  await page.mouse.up();
  let [region] = await appState<Reg[]>(page, 's.regions');
  expect(dist(beats, region!.end)).toBeLessThan(1e-6);

  // with Shift held the edge moves freely (off the beat grid)
  const handle2 = page.locator('[part~="region-handle-right"]').first();
  const box2 = await handle2.boundingBox();
  const x2 = box2!.x + box2!.width / 2;
  await page.keyboard.down('Shift');
  await page.mouse.move(x2, y);
  await page.mouse.down();
  await page.mouse.move(x2 + 3, y, { steps: 3 });
  await page.mouse.move(x2 + 7, y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  [region] = await appState<Reg[]>(page, 's.regions');
  expect(dist(beats, region!.end)).toBeGreaterThan(0.004);
  void bars;
});

test('meter, bar-line shift and tempo override re-run the analysis', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const beats0 = await appState<number[]>(page, 's.analysis.beats');
  const phase0 = await appState<number>(page, 's.analysis.barPhase');

  await page.getByTestId('bar-shift-right').click();
  await expect.poll(() => appState<number>(page, 's.analysis.barPhase')).toBe((phase0 + 1) % 4);
  await page.getByTestId('bar-shift-left').click();
  await expect.poll(() => appState<number>(page, 's.analysis.barPhase')).toBe(phase0);

  await page.getByTestId('meter-select').selectOption('3');
  await expect.poll(() => appState<number>(page, 's.analysis.beatsPerBar')).toBe(3);
  expect(await appState<number[]>(page, 's.analysis.beats')).toEqual(beats0); // beats were not recomputed
  await page.getByTestId('meter-select').selectOption('4');
  await expect.poll(() => appState<number>(page, 's.analysis.beatsPerBar')).toBe(4);

  await page.getByTestId('tempo-select').selectOption({ index: 1 });
  await expect.poll(() => appState<number>(page, 's.analysis.bpm')).toBeLessThan(65);
  const halfBeats = await appState<number[]>(page, 's.analysis.beats');
  expect(halfBeats.length).toBeLessThan(beats0.length * 0.6);
});
