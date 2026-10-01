import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { formatClock, formatTime, parseClock } from '../../src/util/time';
import { appState, decodeInBrowser, dragSelect, loadFixture, makeChordFixture, parseWav, waitForAnalysis } from './helpers';

// SPEC-v1.3.md 2: cuts are spans of the original song that the extended song skips.

interface CutState {
  id: string;
  start: number;
  end: number;
}
interface LoopState {
  id: string;
  start: number;
  end: number;
  repeats: number;
}

const cuts = (page: Page): Promise<CutState[]> => appState<CutState[]>(page, 's.cuts');
const loops = (page: Page): Promise<LoopState[]> => appState<LoopState[]>(page, 's.regions');

async function setUp(page: Page): Promise<{ duration: number }> {
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  return { duration: fixture.duration };
}

async function addLoop(page: Page, start: number, end: number, extra: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    ([a, b, x]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }, e: Record<string, unknown>): string | null } }).songLooper.addLoop(
        { start: a as number, end: b as number },
        x as Record<string, unknown>,
      ),
    [start, end, extra] as const,
  );
}

/**
 * A cut made the way the user does it with times: the playhead goes where the cut should begin, the Cut selection button
 * opens a short cut there, and the end and start fields are typed (the end first, so that the start never has to pass it).
 */
async function typeCut(page: Page, start: string, end: string): Promise<void> {
  const n = (await cuts(page)).length;
  const at = parseClock(start) ?? 0;
  await page.evaluate((t) => (window as unknown as { songLooper: { player: { seek(t: number): void } } }).songLooper.player.seek(t), at);
  await page.getByTestId('cut-selection').click();
  await expect(page.getByTestId('cut')).toHaveCount(n + 1);
  const row = page.getByTestId('cut').nth(n);
  // the end first, so that the start never has to pass it
  await row.getByTestId('cut-end').fill(end);
  await row.getByTestId('cut-end').press('Enter');
  await row.getByTestId('cut-start').fill(start);
  await row.getByTestId('cut-start').press('Enter');
}

test('drag a selection and press X: it becomes a hatched cut on the waveform, in the Cuts card, and the song gets shorter', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { duration } = await setUp(page);
  await expect(page.getByTestId('cuts-empty')).toBeVisible();
  await dragSelect(page, 0.3, 0.45);
  await page.keyboard.press('x');
  await expect(page.getByTestId('cut')).toHaveCount(1);
  await expect(page.getByTestId('cuts-empty')).toBeHidden();
  const [c] = await cuts(page);
  expect(c!.end - c!.start).toBeGreaterThan(3);
  // the selection became the cut (it is gone), and the cut is selected
  expect(await appState<unknown>(page, 's.selection')).toBeNull();
  expect(await appState<string>(page, 's.selectedId')).toBe(c!.id);
  await expect(page.getByTestId('cut')).toHaveClass(/selected/);
  await expect(page.getByTestId('cut-start')).toHaveValue(formatClock(c!.start));
  await expect(page.getByTestId('cut-end')).toHaveValue(formatClock(c!.end));
  await expect(page.getByTestId('cut-length')).toContainText(`Length ${(c!.end - c!.start).toFixed(3)} s`);
  // the song is shorter by the cut, in the length panel, and the strip has a scissors at the join
  await expect(page.getByTestId('length-original')).toHaveText(formatTime(duration));
  await expect(page.getByTestId('length-extended')).toHaveText(formatTime(duration - (c!.end - c!.start)));
  await expect(page.getByTestId('cut-mark')).toHaveCount(1);
  // on the waveform: a region with the hatching and a scissors label
  const look = await page.evaluate((id) => {
    const root = document.querySelector('[data-testid=waveform] > div')!.shadowRoot!;
    const node = root.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!;
    return { kind: node.dataset.kind, image: getComputedStyle(node).backgroundImage, text: node.textContent };
  }, c!.id);
  expect(look.kind).toBe('cut');
  expect(look.image).toContain('repeating-linear-gradient');
  expect(look.text).toContain('✂');
  expect(errors).toEqual([]);
});

test('typed times: exact, never snapped; nudges, Set from playhead, I and O, overlap refusals and Delete', async ({ page }) => {
  const { duration } = await setUp(page);
  await typeCut(page, '0:10.000', '0:12.345');
  let [c] = await cuts(page);
  expect(c).toMatchObject({ start: 10, end: 12.345 });
  const row = page.getByTestId('cut').first();
  await expect(row.getByTestId('cut-length')).toContainText('Length 2.345 s');
  await expect(page.getByTestId('length-extended')).toHaveText(formatTime(duration - 2.345));

  // nudges: exactly 10 ms
  await row.getByTestId('cut-start-ms-inc').click();
  expect((await cuts(page))[0]!.start).toBe(10.01);
  await row.getByTestId('cut-start-ms-dec').click();
  await row.getByTestId('cut-end-ms-dec').click();
  expect(await cuts(page)).toMatchObject([{ start: 10, end: 12.335 }]);
  await row.getByTestId('cut-end-beat-inc').click(); // one beat (0.5 s at 120 BPM) later
  expect((await cuts(page))[0]!.end).toBeGreaterThan(12.8);
  expect((await cuts(page))[0]!.end).toBeLessThan(12.9);

  // Set from playhead, and the I and O keys with the cut selected
  const seek = (t: number): Promise<void> =>
    page.evaluate((x) => (window as unknown as { songLooper: { player: { seek(t: number): void } } }).songLooper.player.seek(x), t);
  await seek(9.5);
  await row.getByTestId('cut-start-playhead').click();
  expect((await cuts(page))[0]!.start).toBe(9.5);
  await row.click({ position: { x: 6, y: 6 } }); // select it (a click on the card's padding)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await seek(14.25);
  await page.keyboard.press('o');
  expect((await cuts(page))[0]!.end).toBe(14.25);
  await seek(8.75);
  await page.keyboard.press('i');
  expect(await cuts(page)).toMatchObject([{ start: 8.75, end: 14.25 }]);

  // a start after the end, junk, and past the end of the song are refused with the reason
  const start = row.getByTestId('cut-start');
  await start.fill('0:20.000');
  await start.press('Enter');
  await expect(page.locator('#' + (await start.getAttribute('id')) + '-msg')).toHaveText('Start must be before end (0:14.250).');
  await start.press('Escape');
  const end = row.getByTestId('cut-end');
  await end.fill(String(duration + 3));
  await end.press('Enter');
  await expect(end).toHaveAttribute('aria-invalid', 'true');
  expect(await cuts(page)).toMatchObject([{ start: 8.75, end: 14.25 }]);
  await end.press('Escape');
  // shorter than 50 ms
  await end.fill('0:08.790');
  await end.press('Enter');
  await expect(page.locator('#' + (await end.getAttribute('id')) + '-msg')).toHaveText('A cut must be at least 0.05 s long.');
  await end.press('Escape');

  // a cut cannot overlap a loop (and a loop cannot overlap a cut): refused, naming the one in the way
  await addLoop(page, 20, 28, { smooth: false });
  await end.fill('0:22.000');
  await end.press('Enter');
  await expect(page.locator('#' + (await end.getAttribute('id')) + '-msg')).toHaveText('Overlaps Loop 1 (0:20.000–0:28.000).');
  await end.press('Escape');
  const loopEnd = page.getByTestId('loop-start').first();
  await loopEnd.fill('0:12.000');
  await loopEnd.press('Enter');
  await expect(page.locator('#' + (await loopEnd.getAttribute('id')) + '-msg')).toHaveText('Overlaps Cut 1 (0:08.750–0:14.250).');
  await loopEnd.press('Escape');
  expect((await loops(page))[0]).toMatchObject({ start: 20, end: 28 });
  // a selection over the first cut is refused, naming it
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => (window as unknown as { songLooper: { store: { set(p: object): void } } }).songLooper.store.set({ selection: { start: 12, end: 18 } }));
  await page.keyboard.press('x');
  await expect(page.getByTestId('notice')).toContainText('Overlaps Cut 1 (0:08.750\u20130:14.250).');
  await expect(page.getByTestId('cut')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { songLooper: { store: { set(p: object): void } } }).songLooper.store.set({ selection: null }));
  // with the playhead inside the first cut, Cut selection opens the new short cut in the free song after it
  await seek(9);
  await page.getByTestId('cut-selection').click();
  await expect(page.getByTestId('cut')).toHaveCount(2);
  expect((await cuts(page))[1]!.start).toBeGreaterThanOrEqual(14.25);
  await page.getByTestId('cut').nth(1).getByTestId('remove-cut').click();
  await expect(page.getByTestId('cut')).toHaveCount(1);

  // Delete removes the selected cut
  await page.getByTestId('cut').first().click({ position: { x: 6, y: 6 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('cut')).toHaveCount(0);
  await expect(page.getByTestId('length-extended')).toHaveText(formatTime(duration + 8)); // the loop (8 s, played twice) is left
  [c] = await cuts(page);
  expect(c).toBeUndefined();
});

test('cuts can start at 0 (the intro goes) and run to the end of the song (the outro goes)', async ({ page }) => {
  const { duration } = await setUp(page);
  await typeCut(page, '0', '0:03.000');
  await expect(page.getByTestId('cut-note')).toContainText('Removes the intro');
  await typeCut(page, String(duration - 2), String(duration));
  await expect(page.getByTestId('cut-note').nth(1)).toContainText('Removes the outro');
  expect(await cuts(page)).toMatchObject([
    { start: 0, end: 3 },
    { start: duration - 2, end: duration },
  ]);
  await expect(page.getByTestId('length-extended')).toHaveText(formatTime(duration - 5));
  await expect(page.getByTestId('cut-mark')).toHaveCount(2); // at the start of the strip and at its end
});

test('Audition cut plays the join (4 s before through 4 s after) and stops on Escape', async ({ page }) => {
  await setUp(page);
  await typeCut(page, '0:10.000', '0:14.000');
  await page.getByTestId('audition-cut').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  const playing = await page.evaluate(() => (window as unknown as { songLooper: { player: { isAuxPlaying(): boolean } } }).songLooper.player.isAuxPlaying());
  expect(playing).toBe(true);
  // the waveform cursor shows where in the song the snippet is: before the cut at first
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { songLooper: { player: { getAuxTime(): number } } }).songLooper.player.getAuxTime())).toBeGreaterThan(0.3);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('play')).toHaveText('Play');
});

test('export with a loop and cuts at the start, in the middle and at the end: the WAV is as long as the timeline, and the preview is the export', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { duration } = await setUp(page);
  // a loop of 8 s played 3 times, and cuts: the intro (4 s), 4 s in the middle, the last 2 s
  await addLoop(page, 8, 16, { smooth: false, repeats: 3 });
  await typeCut(page, '0', '0:04.000');
  await typeCut(page, '0:20.000', '0:24.000');
  await typeCut(page, String(duration - 2), String(duration));
  const expected = duration - 4 - 4 - 2 + 2 * 8;
  await expect(page.getByTestId('length-extended')).toHaveText(formatTime(expected));

  // the live preview is the same samples as renderRange over the same span, across every join (cuts included)
  const span = await page.evaluate(
    (seconds) =>
      (window as unknown as { songLooper: { captureExtendedPreview(o: { fromSeconds: number; seconds: number }): Promise<{ maxDifference: number; peak: number; firstDifferent: number }> } }).songLooper.captureExtendedPreview({
        fromSeconds: 0,
        seconds,
      }),
    expected - 0.5,
  );
  expect(span.peak).toBeGreaterThan(0.05);
  expect(span.maxDifference).toBe(0);

  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const wav = readFileSync((await download.path())!);
  const info = parseWav(wav);
  expect(info.riffSizeOk).toBe(true);
  expect(Math.abs(info.duration - expected)).toBeLessThan(0.02);
  const decoded = await decodeInBrowser(page, wav);
  expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
  expect(decoded.peak).toBeGreaterThan(0.2);
  process.stdout.write(`cuts export: timeline ${expected} s, WAV ${info.duration.toFixed(4)} s\n`);
  // 16-bit samples (with their 1 LSB of dither): the fade-in at the very start begins at silence, the fade-out ends in it
  const first = wav.readInt16LE(44);
  const last = wav.readInt16LE(wav.length - 2);
  expect(Math.abs(first)).toBeLessThanOrEqual(2);
  expect(Math.abs(last)).toBeLessThanOrEqual(2);
  // ... and the music is there 20 ms in
  const early = Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(wav.readInt16LE(44 + (2 * 44100 * 0.2 + i) * 4))));
  expect(early).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});

test('target-length mode counts the song without its cuts when it picks repeats', async ({ page }) => {
  const { duration } = await setUp(page);
  await addLoop(page, 8, 16, { smooth: false });
  await typeCut(page, '0:20.000', '0:30.000');
  await page.getByTestId('length-mode-target').check();
  // the song without the cut is 22 s: a 20 s target changes nothing, a 70 s one adds six passes of the loop (8 s each)
  await page.getByTestId('target-input').fill('0:20');
  await page.getByTestId('target-input').press('Enter');
  await expect(page.getByTestId('length-note')).toHaveText('The target is not longer than the song, so nothing repeats.');
  await page.getByTestId('target-input').fill('1:10');
  await page.getByTestId('target-input').press('Enter');
  const [loop] = await loops(page);
  const length = duration - 10 + (loop!.repeats - 1) * 8;
  expect(Math.abs(length - 70)).toBeLessThanOrEqual(4);
  await expect(page.getByTestId('length-extended')).toHaveText(formatTime(length));
  expect(loop!.repeats).toBe(7);
});

test('playing the extended song goes over the join: the song is shorter by the cut, and extended time maps to the original across it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { duration } = await setUp(page);
  await typeCut(page, '0:10.000', '0:14.000');
  await page.getByTestId('mode-extended').click();
  expect(await page.evaluate(() => (window as unknown as { songLooper: { player: { duration: number } } }).songLooper.player.duration)).toBeCloseTo(duration - 4, 1);
  await page.evaluate(() => (window as unknown as { songLooper: { player: { seek(t: number): void } } }).songLooper.player.seek(9.0));
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  // after the join the cursor on the waveform is past the cut
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { songLooper: { player: { getTime(): number } } }).songLooper.player.getTime()), { timeout: 10_000 })
    .toBeGreaterThan(11);
  await page.getByTestId('play').click();
  // extended time 11 s is original time 15 s (the 4 s cut lies between)
  const mapped = await page.evaluate(() => {
    const tl = (window as unknown as { songLooper: { timeline: { start: number; end: number; outStart: number; outEnd: number }[] } }).songLooper.timeline;
    const seg = tl.find((x) => x.outStart <= 11 && 11 < x.outEnd)!;
    return seg.start + (11 - seg.outStart);
  });
  expect(mapped).toBe(15);
  expect(errors).toEqual([]);
});

test('a cut is dragged and resized on the waveform like a loop: bars by default, Shift for free, never over a loop', async ({ page }) => {
  const { duration } = await setUp(page);
  await addLoop(page, 22, 30, { smooth: false });
  await dragSelect(page, 0.2, 0.3);
  await page.keyboard.press('x');
  await expect(page.getByTestId('cut')).toHaveCount(1);
  const bars = await appState<number[]>(page, 's.grid.bars');
  const onBar = (t: number): boolean => bars.some((b) => Math.abs(b - t) < 1e-6);
  const [c0] = await cuts(page);
  expect(onBar(c0!.start)).toBe(true);
  const rect = (): Promise<{ x: number; y: number; w: number; h: number }> =>
    page.evaluate((id) => {
      const root = document.querySelector('[data-testid=waveform] > div')!.shadowRoot!;
      const r = root.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, c0!.id);
  // drag distances in seconds of the song, so the test does not depend on how wide the waveform is
  const wave = (await page.getByTestId('waveform').boundingBox())!;
  const px = (seconds: number): number => (seconds * wave.width) / duration;
  const drag = async (fromX: number, dx: number, y: number): Promise<void> => {
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(fromX + (dx * i) / 12, y);
    await page.mouse.up();
  };
  // the body: it keeps its length and its start lands on a bar line
  let r = await rect();
  const length = c0!.end - c0!.start;
  await drag(r.x + r.w / 2, px(3), r.y + r.h / 2);
  let [c] = await cuts(page);
  expect(c!.start).toBeGreaterThan(c0!.start);
  expect(onBar(c!.start)).toBe(true);
  expect(c!.end - c!.start).toBeCloseTo(length, 6);
  // the right edge (a handle): the end lands on a bar line
  r = await rect();
  const before = c!.end;
  await drag(r.x + r.w - 3, px(3), r.y + r.h / 2);
  [c] = await cuts(page);
  expect(c!.end).toBeGreaterThan(before);
  expect(onBar(c!.end)).toBe(true);
  // Shift: free
  r = await rect();
  await page.keyboard.down('Shift');
  await drag(r.x + r.w - 3, px(0.7), r.y + r.h / 2);
  await page.keyboard.up('Shift');
  [c] = await cuts(page);
  expect(onBar(c!.end)).toBe(false);
  // dragged up against the loop it stops at it
  r = await rect();
  await drag(r.x + r.w / 2, px(20), r.y + r.h / 2);
  [c] = await cuts(page);
  expect(c!.end).toBeLessThanOrEqual(22 + 1e-9);
  expect(await cuts(page)).toHaveLength(1);
  // the fields followed
  await expect(page.getByTestId('cut-end')).toHaveValue(formatClock(c!.end));
});
