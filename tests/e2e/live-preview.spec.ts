import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { clickTrackFixture, loadFixture, makeChordFixture, waitForAnalysis } from './helpers';

// SPEC-v1.2.md 2.3: the extended preview is played in chunks rendered a few seconds ahead, not rendered whole.

interface PlayerApi {
  getTime(): number;
  getAnalyser(): AnalyserNode;
  isPlaying(): boolean;
  duration: number;
}

const player = <T,>(page: Page, fn: (p: PlayerApi) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.songLooper.player)`) as Promise<T>;

async function outputPeak(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (duration) => {
    const p = (window as unknown as { songLooper: { player: PlayerApi } }).songLooper.player;
    const analyser = p.getAnalyser();
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

async function addExactLoop(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ([a, b]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({
        start: a! - 0.5,
        end: b! + 0.5,
      }),
    [start, end],
  );
  const startField = page.getByTestId('loop-start').first();
  await startField.fill(String(start));
  await startField.press('Enter');
  const endField = page.getByTestId('loop-end').first();
  await endField.fill(String(end));
  await endField.press('Enter');
}

async function setRepeats(page: Page, n: number): Promise<void> {
  const repeats = page.getByTestId('repeats').first();
  await repeats.fill(String(n));
  await repeats.press('Enter');
  await expect(repeats).toHaveValue(String(n));
}

interface Capture {
  frames: number;
  maxDifference: number;
  joinDifference: number;
  firstDifferent: number;
  peak: number;
  joins: number;
}
const capture = (page: Page, fromSeconds: number, seconds: number, contextRate?: number): Promise<Capture> =>
  page.evaluate(
    ([from, secs, rate]) =>
      (window as unknown as { songLooper: { captureExtendedPreview(o: object): Promise<Capture> } }).songLooper.captureExtendedPreview({
        fromSeconds: from,
        seconds: secs,
        ...(rate ? { contextRate: rate } : {}),
      }),
    [fromSeconds, seconds, contextRate ?? 0] as const,
  );

test('repeats 500 on a short song: the length panel is right, and the extended preview plays, seeks and ends with no errors', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await addExactLoop(page, 5.25, 15.25); // 10 s
  await setRepeats(page, 500);
  // 30 s + 499 x 10 s = 5020 s = 1:23:40
  await expect(page.getByTestId('length-extended')).toHaveText('1:23:40');
  await expect(page.getByTestId('length-original')).toHaveText('0:30');
  await expect(page.getByTestId('length-note')).toContainText('long file');
  // the strip stays light: one block per run of repeats, not one per play
  expect(await page.locator('[data-testid=timeline] .tl-block').count()).toBeLessThan(10);
  expect(await page.locator('[data-testid=timeline] .tl-block.run').first().getAttribute('data-plays')).toBe('500');

  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('render-status')).toHaveText('');
  await expect(page.getByTestId('time')).toContainText('/ 1:23:40.0');
  expect(await player(page, (p) => p.duration)).toBeCloseTo(5020, 3);

  // plays, with sound
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  expect(await outputPeak(page, 700)).toBeGreaterThan(0.01);
  const t0 = await player(page, (p) => p.getTime());
  expect(t0).toBeGreaterThan(0.3);

  // seek to the middle by clicking the strip while it plays: the queue restarts there and playing goes on
  const tl = (await page.getByTestId('timeline').boundingBox())!;
  await page.getByTestId('timeline').click({ position: { x: tl.width * 0.5, y: tl.height / 2 } });
  await page.waitForTimeout(500);
  const mid = await player(page, (p) => p.getTime());
  expect(Math.abs(mid - 2510)).toBeLessThan(5020 * 0.03);
  expect(await player(page, (p) => p.isPlaying())).toBe(true);
  expect(await outputPeak(page, 700)).toBeGreaterThan(0.01);
  await expect(page.getByTestId('time')).toContainText('/ 1:23:40.0');
  // the readout handles hours
  await expect(page.getByTestId('time')).toContainText(/^\d+:\d\d(:\d\d)?\.\d \/ 1:23:40\.0$/);

  // and again, and a seek deep into the song across hundreds of repeats
  await page.getByTestId('timeline').click({ position: { x: tl.width * 0.93, y: tl.height / 2 } });
  await page.waitForTimeout(400);
  expect(Math.abs((await player(page, (p) => p.getTime())) - 5020 * 0.93)).toBeLessThan(5020 * 0.03);
  expect(await outputPeak(page, 700)).toBeGreaterThan(0.01);

  // seeking while paused moves the playhead without starting
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  await page.getByTestId('timeline').click({ position: { x: tl.width * 0.25, y: tl.height / 2 } });
  await page.waitForTimeout(200);
  expect(await player(page, (p) => p.isPlaying())).toBe(false);
  expect(Math.abs((await player(page, (p) => p.getTime())) - 1255)).toBeLessThan(5020 * 0.03);

  // play on to the very end: it stops by itself
  await page.evaluate(() => {
    const p = (window as unknown as { songLooper: { player: { seek(t: number): void; duration: number } } }).songLooper.player;
    p.seek(p.duration - 3);
  });
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play', { timeout: 20_000 });
  expect(await player(page, (p) => p.isPlaying())).toBe(false);
  expect(errors).toEqual([]);
});

test('the scheduler leaves no gap and no overlap at chunk joins: its samples equal renderRange over the same span', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  // loop A with a bridge (a smoothed seam with several jumps), repeated: seams fall all over the 5 s chunks
  await page.evaluate(() =>
    (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: 0, end: 8 }),
  );
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/^Bridge: 4 bars/);
  await setRepeats(page, 7);

  // 28 s of the extended song from 3 s: five joins, and several seams of the loop and its bridge
  const exact = await capture(page, 3, 28);
  expect(exact.joins).toBeGreaterThanOrEqual(5);
  expect(exact.peak).toBeGreaterThan(0.05);
  expect(exact.firstDifferent).toBe(-1);
  expect(exact.maxDifference).toBe(0);
  // from a start in the middle of a chunk, and a span that ends in the middle of one
  const odd = await capture(page, 12.3456, 17.2);
  expect(odd.joins).toBeGreaterThanOrEqual(3);
  expect(odd.maxDifference).toBe(0);
  // the very start and across the end of the song
  const start = await capture(page, 0, 12);
  expect(start.maxDifference).toBe(0);

  // a context at another sample rate resamples every chunk in the browser: joins stay as clean as one long source
  const rate48 = await capture(page, 3, 20, 48000);
  expect(rate48.peak).toBeGreaterThan(0.05);
  expect(rate48.joins).toBeGreaterThanOrEqual(4);
  expect(rate48.joinDifference).toBeLessThan(1e-5); // float32 rounding: no tick at any join
  expect(rate48.maxDifference).toBeLessThan(2e-3); // the browser's interpolation of a start inside a chunk (-54 dB)
  const rate32 = await capture(page, 7, 20, 32000);
  expect(rate32.joinDifference).toBeLessThan(1e-5);
  expect(rate32.maxDifference).toBeLessThan(1e-5);
  process.stdout.write(
    `live preview vs renderRange (song 44.1 kHz): same rate max diff ${exact.maxDifference}; 48 kHz context max diff ${rate48.maxDifference}, at joins ${rate48.joinDifference}; 32 kHz max diff ${rate32.maxDifference}\n`,
  );
  expect(errors).toEqual([]);
});

test('speed and pitch work on the extended preview, through one SoundTouch node; changing them while playing rebuilds from the same place', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await page.evaluate(() =>
    (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: 0, end: 16 }),
  );
  await setRepeats(page, 12);
  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('render-status')).toHaveText('');

  await page.getByTestId('speed-input').fill('1.25');
  await page.getByTestId('speed-input').press('Enter');
  await page.getByTestId('pitch-input').fill('-1.5');
  await page.getByTestId('pitch-input').press('Enter');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.waitForTimeout(600);
  const a0 = await player(page, (p) => p.getTime());
  const w0 = Date.now();
  const peak = await outputPeak(page, 1500);
  const a1 = await player(page, (p) => p.getTime());
  const rate = (a1 - a0) / ((Date.now() - w0) / 1000);
  expect(rate).toBeGreaterThan(1.1);
  expect(rate).toBeLessThan(1.4);
  expect(peak).toBeGreaterThan(0.01);

  // a new speed while playing: the position carries on from where it was
  const before = await player(page, (p) => p.getTime());
  await page.getByTestId('speed-input').fill('0.75');
  await page.getByTestId('speed-input').press('Enter');
  const after = await player(page, (p) => p.getTime());
  expect(Math.abs(after - before)).toBeLessThan(0.4);
  await page.waitForTimeout(400);
  const b0 = await player(page, (p) => p.getTime());
  const bw = Date.now();
  await page.waitForTimeout(1500);
  const b1 = await player(page, (p) => p.getTime());
  const slow = (b1 - b0) / ((Date.now() - bw) / 1000);
  expect(slow).toBeGreaterThan(0.6);
  expect(slow).toBeLessThan(0.9);

  // pitch alone: no rebuild, keeps playing
  const c0 = await player(page, (p) => p.getTime());
  await page.getByTestId('pitch-input').fill('2.25');
  await page.getByTestId('pitch-input').press('Enter');
  await page.waitForTimeout(300);
  const c1 = await player(page, (p) => p.getTime());
  expect(c1 - c0).toBeGreaterThan(0.1);
  expect(c1 - c0).toBeLessThan(1.2);
  expect(await outputPeak(page, 400)).toBeGreaterThan(0.01);

  // seek while playing at this speed
  const tl = (await page.getByTestId('timeline').boundingBox())!;
  await page.getByTestId('timeline').click({ position: { x: tl.width * 0.6, y: tl.height / 2 } });
  await page.waitForTimeout(500);
  const dur = await player(page, (p) => p.duration);
  expect(Math.abs((await player(page, (p) => p.getTime())) - dur * 0.6)).toBeLessThan(dur * 0.05);
  expect(await outputPeak(page, 400)).toBeGreaterThan(0.01);

  // reset: neutral routing again, still audible
  await page.getByTestId('speed-pitch-reset').click();
  await page.waitForTimeout(300);
  const n0 = await player(page, (p) => p.getTime());
  const nw = Date.now();
  expect(await outputPeak(page, 800)).toBeGreaterThan(0.01);
  const n1 = await player(page, (p) => p.getTime());
  const normal = (n1 - n0) / ((Date.now() - nw) / 1000);
  expect(normal).toBeGreaterThan(0.9);
  expect(normal).toBeLessThan(1.1);
  await page.getByTestId('play').click();
  expect(errors).toEqual([]);
});

test('editing the plan while the extended preview plays carries on from the same place', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await page.evaluate(() =>
    (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: 0, end: 8 }),
  );
  await setRepeats(page, 6);
  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('render-status')).toHaveText('');
  await page.getByTestId('play').click();
  await page.waitForTimeout(800);
  const before = await player(page, (p) => p.getTime());
  await setRepeats(page, 9);
  await page.waitForTimeout(900); // the debounce, then the new cut
  const after = await player(page, (p) => p.getTime());
  expect(after).toBeGreaterThan(before);
  expect(await player(page, (p) => p.isPlaying())).toBe(true);
  expect(await player(page, (p) => p.duration)).toBeGreaterThan(32 + 8 * 7);
  expect(await outputPeak(page, 400)).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});
