import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { formatClock, formatTime } from '../../src/util/time';
import { appState, decodeInBrowser, loadFixture, makeChordFixture, makeFixture, parseWav, waitForAnalysis, wavFixture } from './helpers';

// SPEC-v1.3.md 7.1: a loop exported as an audio file of its own.

interface LoopState {
  id: string;
  start: number;
  end: number;
  repeats: number;
  bridge?: boolean;
  seam?: { loopStart: number; loopEnd: number; bridge: unknown; jumps: { from: number; to: number; fadeMs?: number; rampSeconds?: number }[] };
}

const loops = (page: Page): Promise<LoopState[]> => appState<LoopState[]>(page, 's.regions');

/** Add a loop by its times; with `smoothed` (the default) wait for its seam plan, so that what the tests read is what is exported. */
async function addLoop(page: Page, start: number, end: number, smoothed = true): Promise<void> {
  await page.evaluate(
    ([a, b]) => (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: a!, end: b! }),
    [start, end],
  );
  if (smoothed) await expect(page.locator('[data-testid=seam-summary]:visible')).toHaveCount((await loops(page)).length);
}

/** A song of short chord sections, loaded and analysed; two loops at times that are not bar lines (their seams do not match). */
async function setUp(page: Page, name = 'loopsong.wav'): Promise<{ duration: number; left: Float32Array }> {
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 }, name);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  return { duration: fixture.duration, left: pcmLeft(fixture.buffer) };
}

/** The left channel of a canonical 16-bit stereo WAV as floats. */
function pcmLeft(wav: Buffer): Float32Array {
  const info = parseWav(wav);
  const frames = info.dataBytes / (info.channels * 2);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = wav.readInt16LE(44 + i * info.channels * 2) / 32768;
  return out;
}

const maxStep = (x: Float32Array, from = 1, to = x.length): number => {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
};

/** Open the Export loop dialog of loop number `n` (1-based) and return what it shows. */
async function openDialog(page: Page, n = 1): Promise<void> {
  await page.getByTestId('export-loop').nth(n - 1).click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
}

/** Press Export in the open dialog and read the file that is downloaded. */
async function download(page: Page): Promise<{ wav: Buffer; name: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  return { wav: readFileSync(await d.path()), name: d.suggestedFilename() };
}

test('every loop has an Export loop button, which opens the dialog in loop mode with its options and a default name', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setUp(page, 'My Song.wav');
  await addLoop(page, 3.3, 9.1);
  await addLoop(page, 20.123, 31.456);
  await expect(page.getByTestId('export-loop')).toHaveCount(2);
  await expect(page.getByTestId('export-loop').first()).toHaveText('Export loop');

  await openDialog(page, 2);
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Export loop');
  // the options: repeats (default 1), Loop-ready (default on), the bake box, the bit depths
  await expect(page.getByTestId('export-repeats')).toHaveValue('1');
  await expect(page.getByTestId('export-loop-ready')).toBeChecked();
  await expect(page.getByTestId('export-bake')).toBeVisible();
  await expect(page.getByTestId('depth-16')).toBeChecked();
  // the default name: <song> - Loop <n> (<start>-<end>).wav with m.ss.mmm times (no colon)
  await expect(page.getByTestId('export-name')).toHaveValue('My Song - Loop 2 (0.20.123-0.31.456).wav');
  await expect(page.getByTestId('export-bridge-note')).toBeHidden();
  // the estimate is the loop's length, not the song's
  await expect(page.getByTestId('export-estimate')).toContainText('0:11');
  await page.getByTestId('export-cancel').click();
  await expect(dialog).toBeHidden();

  // the dialog for the whole song is the one it was: no loop options, the old title and name
  await page.getByTestId('export').click();
  await expect(dialog.getByRole('heading')).toHaveText('Export WAV');
  await expect(page.getByTestId('export-repeats')).toBeHidden();
  await expect(page.getByTestId('export-loop-ready')).toBeHidden();
  await expect(page.getByTestId('export-name')).toHaveValue('My Song (extended).wav');
  await page.getByTestId('export-cancel').click();
  expect(errors).toEqual([]);
});

test('the default name has no character a file system refuses, whatever the song is called', async ({ page }) => {
  await setUp(page, 'Live: take 1? <a|b>.wav');
  await addLoop(page, 3.3, 9.1);
  await openDialog(page);
  const name = await page.getByTestId('export-name').inputValue();
  expect(name).toBe('Live_ take 1_ _a_b_ - Loop 1 (0.03.300-0.09.100).wav');
  expect(name).not.toMatch(/[\\/:*?"<>|]/);
  const { name: saved } = await download(page);
  expect(saved).toBe(name);
});

test('export with 1 repeat, loop-ready: the file is the loop, as long as the loop, and joins to itself without a jump', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { left } = await setUp(page);
  await addLoop(page, 3.3, 9.1);
  const [loop] = await loops(page);
  const len = loop!.end - loop!.start;

  await openDialog(page);
  const ready = await download(page);
  const info = parseWav(ready.wav);
  expect(info.format).toBe(1);
  expect(info.channels).toBe(2);
  expect(info.sampleRate).toBe(44100);
  expect(info.bitsPerSample).toBe(16);
  expect(info.riffSizeOk).toBe(true);
  // the played span (smoothing may rotate it by up to a beat, but the length is the loop's), edges snapped by 2 ms at most
  const seam = loop!.seam;
  const expected = seam ? seam.loopEnd - seam.loopStart : len;
  expect(Math.abs(info.duration - expected)).toBeLessThan(0.02);
  const decoded = await decodeInBrowser(page, ready.wav);
  expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
  expect(decoded.peak).toBeGreaterThan(0.2);

  // the same loop without Loop-ready: identical except for the end, which jumps back to the start
  await openDialog(page);
  await page.getByTestId('export-loop-ready').uncheck();
  const plain = await download(page);
  const a = pcmLeft(ready.wav);
  const b = pcmLeft(plain.wav);
  expect(a.length).toBe(b.length);
  const wrap = Math.round(0.02 * 44100); // the default Seam fade is 20 ms
  let firstDifferent = a.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      firstDifferent = i;
      break;
    }
  }
  expect(a.length - firstDifferent).toBeLessThanOrEqual(wrap + 2);
  expect(a.length - firstDifferent).toBeGreaterThan(wrap * 0.5);
  // repeated end-to-start, the loop-ready file steps no more than the song itself does. (Whether the plain file jumps depends on the
  // song: the loop's edges snap to zero crossings, and this fixture's channels are copies of each other. The unit tests use a
  // loop that does not match, and show the plain file jumping by more than twice the song's largest step.)
  const natural = maxStep(left);
  const join = (x: Float32Array): number => Math.abs(x[0]! - x[x.length - 1]!);
  console.warn(`loop-ready join ${join(a).toFixed(5)}, plain join ${join(b).toFixed(5)}, the song's own largest step ${natural.toFixed(5)}`);
  expect(join(a)).toBeLessThanOrEqual(natural * 1.05);
  expect(errors).toEqual([]);
});

test('a loop whose edges do not match: the plain file jumps at its join, the loop-ready one steps as the song does', async ({ page }) => {
  // a stereo chord whose partials never line up with the loop's length, and whose channels differ (so that snapping the
  // edges to a zero crossing of the middle does not make the left channel match as well)
  const sr = 22050;
  const n = sr * 12;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    left[i] = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 331 * t + 1) + 0.15 * Math.sin(2 * Math.PI * 523 * t);
    right[i] = 0.22 * Math.sin(2 * Math.PI * 220.5 * t + 0.3) + 0.2 * Math.sin(2 * Math.PI * 330 * t) + 0.15 * Math.sin(2 * Math.PI * 524 * t + 2);
  }
  const fixture = await wavFixture([left, right], sr, 'chord.wav');
  await loadFixture(page, fixture);
  await addLoop(page, 3.123, 6.789, false);
  const song = pcmLeft(fixture.buffer);
  const natural = maxStep(song);
  const joins: Record<string, number> = {};
  for (const loopReady of [true, false]) {
    await openDialog(page);
    if (!loopReady) await page.getByTestId('export-loop-ready').uncheck();
    const { wav } = await download(page);
    const x = pcmLeft(wav);
    expect(Math.abs(parseWav(wav).duration - (6.789 - 3.123))).toBeLessThan(0.02);
    joins[loopReady ? 'ready' : 'plain'] = Math.abs(x[0]! - x[x.length - 1]!);
  }
  console.warn(`loop-ready join ${joins.ready!.toFixed(5)}, plain join ${joins.plain!.toFixed(5)}, the song's own largest step ${natural.toFixed(5)}`);
  expect(joins.ready!).toBeLessThanOrEqual(natural * 1.05);
  expect(joins.plain!).toBeGreaterThan(natural * 1.5);
});

test('export with 4 repeats: four passes with the normal seam between them, and the first pass is the 1-repeat file', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 3.3, 9.1);
  const [loop] = await loops(page);
  await openDialog(page);
  const one = await download(page);

  await openDialog(page);
  await page.getByTestId('export-repeats').fill('4');
  await page.getByTestId('export-repeats').press('Enter');
  await expect(page.getByTestId('export-repeats')).toHaveValue('4');
  const dur = (await page.getByTestId('export-estimate').textContent())!;
  expect(dur).toContain('0:23'); // 4 x 5.8 s
  const four = await download(page);
  const i1 = parseWav(one.wav);
  const i4 = parseWav(four.wav);
  const cycle = loop!.seam ? loop!.seam.jumps[0]!.from - loop!.seam.loopStart : loop!.end - loop!.start;
  const len = loop!.seam ? loop!.seam.loopEnd - loop!.seam.loopStart : loop!.end - loop!.start;
  const expected = 3 * cycle + len;
  expect(Math.abs(i4.duration - expected)).toBeLessThan(0.02);
  expect(Math.abs(i4.duration - 4 * i1.duration)).toBeLessThan(0.05);
  expect(i4.riffSizeOk).toBe(true);
  // the pieces were rendered by the same code: up to the first seam the 4-repeat file is the 1-repeat file. (The seam reaches back
  // before the join: half its fade, and the level ramp that meets the start's level, up to a beat; and the 1-repeat file's own
  // end is crossfaded for the Seam fade, 20 ms.)
  const a = pcmLeft(one.wav);
  const b = pcmLeft(four.wav);
  const jump = loop!.seam?.jumps[0];
  const reach = Math.max((jump?.fadeMs ?? 20) / 2000, jump?.rampSeconds ?? 0, 0.02);
  const same = a.length - Math.round((reach + 0.01) * 44100);
  expect(same).toBeGreaterThan(44100 * 2);
  for (let i = 0; i < same; i++) if (a[i] !== b[i]) throw new Error(`the 4-repeat file differs from the 1-repeat file at sample ${i}`);
  // the join of the file to itself is still the song's: Loop-ready applies to the end of the last pass
  const decoded = await decodeInBrowser(page, four.wav);
  expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
});

test('the file holds the Smooth seam plan\'s rotated span, and leaves a bridge out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const a = fixture.sections[0]!;
  await addLoop(page, a.start, a.end);
  await expect(page.getByTestId('seam-summary').first()).toBeVisible();
  const smooth = (await loops(page))[0]!;
  expect(smooth.seam).toBeTruthy();
  await page.getByTestId('repeats').first().fill('3');
  await page.getByTestId('repeats').first().press('Enter');

  // the plan's span and cycle (a smoothed seam may leave a few ms after the loop's end)
  await openDialog(page);
  await page.getByTestId('export-repeats').fill('3');
  await page.getByTestId('export-repeats').press('Enter');
  const plain = await download(page);
  const s = (await loops(page))[0]!.seam!;
  const cycle = s.jumps[0]!.from - s.loopStart;
  expect(Math.abs(parseWav(plain.wav).duration - (2 * cycle + (s.loopEnd - s.loopStart)))).toBeLessThan(0.02);

  // with Bridge on: a note in the dialog, and the file is the loop, three times, with no bridge in it
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/^Bridge: 4 bars/);
  const bridged = (await loops(page))[0]!;
  expect(bridged.seam!.bridge).toBeTruthy();
  await openDialog(page);
  await expect(page.getByTestId('export-bridge-note')).toBeVisible();
  await expect(page.getByTestId('export-bridge-note')).toContainText('Bridge');
  await page.getByTestId('export-repeats').fill('3');
  await page.getByTestId('export-repeats').press('Enter');
  const file = await download(page);
  const span = bridged.seam!.loopEnd - bridged.seam!.loopStart;
  expect(Math.abs(parseWav(file.wav).duration - 3 * span)).toBeLessThan(0.02);
  // and the extended export of the same song does have the bridge (it is longer by 2 x the bridge)
  expect(parseWav(file.wav).duration).toBeLessThan(3 * span + 0.05);
  expect(errors).toEqual([]);
});

test('the dialog checks the repeats, shows the length for them, and refuses a file a WAV cannot hold', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 3.3, 9.1);
  await openDialog(page);
  const repeats = page.getByTestId('export-repeats');
  // 1 to 9,999, whole numbers
  await repeats.fill('0');
  await repeats.press('Enter');
  await expect(repeats).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#export-repeats-msg')).toHaveText('Enter a value from 1 to 9999.');
  await repeats.fill('2.5');
  await repeats.press('Enter');
  await expect(page.locator('#export-repeats-msg')).toHaveText('Enter a whole number.');
  await repeats.fill('10000');
  await repeats.press('Enter');
  await expect(repeats).toHaveAttribute('aria-invalid', 'true');
  // the estimate follows
  await repeats.fill('10');
  await repeats.press('Enter');
  await expect(repeats).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('export-estimate')).toContainText('0:58');
  await page.getByTestId('depth-24').check();
  await expect(page.getByTestId('export-estimate')).toContainText('0:58');
  // 9,999 repeats of 5.8 s is 16 hours: more than a WAV holds, so Export is off and says why
  await repeats.fill('9999');
  await repeats.press('Enter');
  await expect(page.getByTestId('export-problem')).toBeVisible();
  await expect(page.getByTestId('export-problem')).toContainText('Too long for a WAV at 24-bit');
  await expect(page.getByTestId('export-confirm')).toBeDisabled();
  await page.getByTestId('depth-16').check();
  await expect(page.getByTestId('export-problem')).toContainText('Too long for a WAV at 16-bit');
  await repeats.fill('100');
  await repeats.press('Enter');
  await expect(page.getByTestId('export-problem')).toBeHidden();
  await expect(page.getByTestId('export-confirm')).toBeEnabled();
  // 99 cycles and the last pass (a smoothed seam may leave a few ms after the loop's end on every one of them)
  const [one] = await loops(page);
  const cycle = one!.seam ? one!.seam.jumps[0]!.from - one!.seam.loopStart : one!.end - one!.start;
  const span = one!.seam ? one!.seam.loopEnd - one!.seam.loopStart : one!.end - one!.start;
  await expect(page.getByTestId('export-estimate')).toContainText(formatTime(99 * cycle + span));
  // the arrow keys step the count
  await repeats.press('ArrowUp');
  await expect(repeats).toHaveValue('101');
  await page.getByTestId('export-cancel').click();
});

test('speed and pitch can be baked into a loop file, which changes its length', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 3.3, 9.1);
  await page.evaluate(() => (window as unknown as { songLooper: { setSpeedPitch(s: number, p: number): void } }).songLooper.setSpeedPitch(1.25, 0));
  await openDialog(page);
  await expect(page.getByTestId('export-bake')).toBeEnabled();
  await page.getByTestId('export-bake').check();
  await page.getByTestId('export-repeats').fill('2');
  await page.getByTestId('export-repeats').press('Enter');
  const { wav } = await download(page);
  const [loop] = await loops(page);
  const span = loop!.seam ? loop!.seam.loopEnd - loop!.seam.loopStart : loop!.end - loop!.start;
  const cycle = loop!.seam ? loop!.seam.jumps[0]!.from - loop!.seam.loopStart : span;
  expect(Math.abs(parseWav(wav).duration - (cycle + span) / 1.25)).toBeLessThan(0.05);
});

test('the extended export is unchanged next to the loop export', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await addLoop(page, 3.3, 9.1);
  const [loop] = await loops(page);
  await page.getByTestId('export').click();
  const { wav, name } = await download(page);
  expect(name).toMatch(/\(extended\)\.wav$/);
  const expected = fixture.duration + (loop!.repeats - 1) * (loop!.end - loop!.start);
  expect(Math.abs(parseWav(wav).duration - expected)).toBeLessThan(0.03);
});

test('Cancel stops a running loop export and nothing is saved', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 3.3, 9.1);
  await openDialog(page);
  // 600 repeats of 5.8 s is an hour of audio (600 MB at 16-bit), under the WAV limit: it runs until it is cancelled
  await page.getByTestId('export-repeats').fill('600');
  await page.getByTestId('export-repeats').press('Enter');
  await page.getByTestId('depth-16').check();
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-status')).toContainText('Export cancelled');
  expect(downloaded).toBe(false);
});

test('the loop file name shows the loop times m.ss.mmm and the loop number follows the loop order', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 20, 26);
  await addLoop(page, 3.3, 9.1);
  // the loops are in song order: the one at 3.3 s is Loop 1
  await openDialog(page, 1);
  await expect(page.getByTestId('export-name')).toHaveValue(`loopsong - Loop 1 (0.03.300-0.09.100).wav`);
  await page.getByTestId('export-cancel').click();
  await openDialog(page, 2);
  await expect(page.getByTestId('export-name')).toHaveValue(`loopsong - Loop 2 (0.20.000-0.26.000).wav`);
  expect(formatClock(20).replace(':', '.')).toBe('0.20.000');
  await page.getByTestId('export-cancel').click();
});
