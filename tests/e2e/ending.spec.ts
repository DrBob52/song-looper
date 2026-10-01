import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { formatClock } from '../../src/util/time';
import { appState, decodeInBrowser, loadFixture, makeChordFixture, parseWav, waitForAnalysis } from './helpers';

// SPEC-v1.3.md 3: end anywhere, then fade out into that point.

interface EndingState {
  endAt: number | null;
  fadeSeconds: number;
}
const ending = (page: Page): Promise<EndingState> => appState<EndingState>(page, 's.ending');

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

async function fill(page: Page, testId: string, value: string): Promise<void> {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press('Enter');
}

const message = async (page: Page, testId: string): Promise<string> =>
  (await page.locator('#' + (await page.getByTestId(testId).getAttribute('id')) + '-msg').textContent()) ?? '';

async function exportWav(page: Page): Promise<Buffer> {
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  return readFileSync((await download.path())!);
}

/** Left-channel samples of a 16-bit stereo WAV. */
const left = (wav: Buffer, frame: number): number => wav.readInt16LE(44 + frame * 4);
const frames = (wav: Buffer): number => (wav.length - 44) / 4;

test('End at and a fade: the length panel says so, the export is exactly that long and fades with a cosine to silence', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { duration } = await setUp(page);
  await expect(page.getByTestId('ending-real')).toBeChecked();
  await expect(page.getByTestId('end-at-input')).toBeDisabled();
  await expect(page.getByTestId('end-at-input')).toHaveValue(formatClock(duration));
  await addLoop(page, 8, 16, { smooth: false, repeats: 2 }); // the song is 8 s longer

  await page.getByTestId('ending-at').check();
  // End at starts at the end of the extended song
  expect(await ending(page)).toEqual({ endAt: Math.floor((duration + 8) * 1000) / 1000, fadeSeconds: 0 });
  await expect(page.getByTestId('end-at-input')).toBeEnabled();
  await fill(page, 'end-at-input', '0:20.500');
  await expect(page.getByTestId('end-at-input')).toHaveValue('0:20.500');
  expect((await ending(page)).endAt).toBe(20.5);
  await expect(page.getByTestId('length-extended')).toHaveText('0:20.500');
  await expect(page.getByTestId('length-ending')).toHaveText('Ends at 0:20.500');
  const plain = await exportWav(page);
  expect(Math.abs(parseWav(plain).duration - 20.5)).toBeLessThan(0.001);
  expect(frames(plain)).toBe(Math.round(20.5 * 44100));

  await fill(page, 'fade-input', '3');
  expect((await ending(page)).fadeSeconds).toBe(3);
  await expect(page.getByTestId('fade-slider')).toHaveValue('3');
  await expect(page.getByTestId('length-ending')).toHaveText('Ends at 0:20.500, fades over 3 s');
  const faded = await exportWav(page);
  expect(frames(faded)).toBe(frames(plain));
  const sr = 44100;
  const total = frames(faded);
  const fadeFrames = 3 * sr;
  const start = total - fadeFrames;
  // before the fade: the same samples (give or take the 16-bit dither)
  let worst = 0;
  for (let i = 0; i < start; i += 97) worst = Math.max(worst, Math.abs(left(faded, i) - left(plain, i)));
  expect(worst).toBeLessThanOrEqual(2);
  // in the fade: the faded file is the plain one times cos(pi/2 * i / (F - 1)); judge it by power over short windows
  const power = (wav: Buffer, from: number, n: number): number => {
    let sum = 0;
    for (let i = from; i < from + n; i++) sum += left(wav, i) ** 2;
    return sum / n;
  };
  const at = (fraction: number): number => {
    const from = start + Math.round(fraction * fadeFrames) - 220;
    return Math.sqrt(power(faded, from, 441) / power(plain, from, 441));
  };
  expect(at(0.5)).toBeGreaterThan(0.69);
  expect(at(0.5)).toBeLessThan(0.725);
  for (const f of [0.25, 0.75, 0.9]) expect(at(f)).toBeCloseTo(Math.cos((Math.PI / 2) * f), 1);
  // and it ends in silence, exactly
  expect(Math.abs(left(faded, total - 1))).toBeLessThanOrEqual(1);
  expect(Math.max(...Array.from({ length: 16 }, (_, i) => Math.abs(left(faded, total - 1 - i))))).toBeLessThanOrEqual(6); // below -74 dBFS
  process.stdout.write(`ending: 20.5 s file with a 3 s fade; power ratio at the fade's middle ${at(0.5).toFixed(3)} (cos 45 deg = 0.707)\n`);

  // a typed fade of 0 means no fade
  await fill(page, 'fade-input', '0');
  expect((await ending(page)).fadeSeconds).toBe(0);
  await expect(page.getByTestId('length-ending')).toHaveText('Ends at 0:20.500');
  const again = await exportWav(page);
  let diff = 0;
  for (let i = 0; i < total; i += 53) diff = Math.max(diff, Math.abs(left(again, i) - left(plain, i)));
  expect(diff).toBeLessThanOrEqual(2);
  const decoded = await decodeInBrowser(page, faded);
  expect(Math.abs(decoded.duration - 20.5)).toBeLessThan(0.001);
  expect(errors).toEqual([]);
});

test('a fade on the real ending covers the last seconds of the extended song', async ({ page }) => {
  const { duration } = await setUp(page);
  await fill(page, 'fade-input', '2.5');
  expect(await ending(page)).toEqual({ endAt: null, fadeSeconds: 2.5 });
  await expect(page.getByTestId('length-extended')).toHaveText(formatClock(duration, 0));
  await expect(page.getByTestId('length-ending')).toHaveText('Fades over 2.5 s');
  const wav = await exportWav(page);
  expect(Math.abs(parseWav(wav).duration - duration)).toBeLessThan(0.001);
  expect(Math.max(...Array.from({ length: 16 }, (_, i) => Math.abs(left(wav, frames(wav) - 1 - i))))).toBeLessThanOrEqual(6);
  // the slider and the field are one control
  await page.getByTestId('fade-slider').fill('7');
  await expect(page.getByTestId('fade-input')).toHaveValue('7.0');
  expect((await ending(page)).fadeSeconds).toBe(7);
});

test('specific messages: past the end, before 0, a fade longer than End at, a fade out of range', async ({ page }) => {
  const { duration } = await setUp(page);
  await page.getByTestId('ending-at').check();
  await fill(page, 'end-at-input', '9:00.000');
  await expect(page.getByTestId('end-at-input')).toHaveAttribute('aria-invalid', 'true');
  expect(await message(page, 'end-at-input')).toBe(`The extended song is only ${formatClock(duration)} long. End at must be before that.`);
  await page.getByTestId('end-at-input').press('Escape');
  await fill(page, 'end-at-input', '0');
  expect(await message(page, 'end-at-input')).toBe('End at must be after 0:00.000.');
  await page.getByTestId('end-at-input').press('Escape');
  await fill(page, 'end-at-input', 'soon');
  expect(await message(page, 'end-at-input')).toBe('Enter a time like 14:20.000, 14:20 or 860.');
  await page.getByTestId('end-at-input').press('Escape');

  await fill(page, 'end-at-input', '0:05');
  await fill(page, 'fade-input', '8');
  expect(await message(page, 'fade-input')).toBe("The fade can't be longer than End at (0:05.000).");
  await expect(page.getByTestId('fade-input')).toHaveAttribute('aria-invalid', 'true');
  expect((await ending(page)).fadeSeconds).toBe(0);
  await page.getByTestId('fade-input').press('Escape');
  await fill(page, 'fade-input', '61');
  expect(await message(page, 'fade-input')).toBe('Enter a value from 0.0 to 60.0.');
  await page.getByTestId('fade-input').press('Escape');
  await fill(page, 'fade-input', '4');
  await fill(page, 'end-at-input', '0:03');
  expect(await message(page, 'end-at-input')).toBe('The fade (4 s) is longer than the song up to End at (0:03.000). Make the fade shorter or End at later.');
  expect(await ending(page)).toEqual({ endAt: 5, fadeSeconds: 4 });
});

test('a shorter extended song resets End at to the real ending, with the notice', async ({ page }) => {
  const { duration } = await setUp(page);
  await addLoop(page, 8, 16, { smooth: false, repeats: 3 }); // 16 s longer
  await page.getByTestId('ending-at').check();
  await fill(page, 'end-at-input', '0:45');
  expect((await ending(page)).endAt).toBe(45);
  await fill(page, 'fade-input', '2');
  await expect(page.getByTestId('ending-notice')).toBeHidden();
  // fewer repeats: the song is 32.5 + 8 = 40.5 s now, before the end point
  await page.getByTestId('repeats').first().fill('2');
  await page.getByTestId('repeats').first().press('Enter');
  expect(await ending(page)).toEqual({ endAt: null, fadeSeconds: 2 });
  await expect(page.getByTestId('ending-real')).toBeChecked();
  await expect(page.getByTestId('ending-notice')).toHaveText('End point was past the new ending, so the song now ends at its real ending.');
  await expect(page.getByTestId('length-extended')).toHaveText(formatClock(duration + 8, 0));
  // the notice goes when the user acts on the ending
  await page.getByTestId('ending-at').check();
  await expect(page.getByTestId('ending-notice')).toBeHidden();
  // a cut that shortens the song does the same
  await fill(page, 'end-at-input', '0:38');
  await page.evaluate(() => (window as unknown as { songLooper: { addCut(x: { start: number; end: number }): string | null } }).songLooper.addCut({ start: 24, end: 30 }));
  expect(await ending(page)).toEqual({ endAt: null, fadeSeconds: 2 });
  await expect(page.getByTestId('ending-notice')).toBeVisible();
  // End at starts from the end of the (shorter) song again: the 0:38 it had no longer fits
  await page.getByTestId('ending-at').check();
  expect((await ending(page)).endAt).toBe(34.5);
});

test('Set from playhead uses the extended timeline, also while playing the extended song', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 8, 16, { smooth: false, repeats: 2 });
  await page.getByTestId('ending-at').check();
  // on the original: the playhead (12 s) is the first play of the loop, 12 s in the extended song as well
  await page.evaluate(() => (window as unknown as { songLooper: { player: { seek(t: number): void } } }).songLooper.player.seek(12));
  await page.getByTestId('end-at-playhead').click();
  expect((await ending(page)).endAt).toBe(12);
  await fill(page, 'end-at-input', '0:40');
  // the extended song: its own clock (it is 8 s ahead of the original after the loop)
  await page.getByTestId('mode-extended').click();
  await page.evaluate(() => (window as unknown as { songLooper: { player: { seek(t: number): void } } }).songLooper.player.seek(30));
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.waitForTimeout(600); // let it play a little: the playhead is past where it started
  await page.getByTestId('end-at-playhead').click();
  const end = (await ending(page)).endAt!;
  expect(end).toBeGreaterThan(30);
  expect(end).toBeLessThan(32.5);
  await page.getByTestId('play').click();
  // the song is now this long, and playing it stops there
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { songLooper: { player: { duration: number } } }).songLooper.player.duration))
    .toBeCloseTo(end, 2);
});

test('the strip shows the end point, dims what lies after it, and draws the fade as a ramp', async ({ page }) => {
  const { duration } = await setUp(page);
  await addLoop(page, 8, 16, { smooth: false, repeats: 3 });
  const natural = duration + 16;
  await expect(page.getByTestId('timeline-ending')).toBeHidden();
  await page.getByTestId('ending-at').check();
  await fill(page, 'end-at-input', '0:30');
  await fill(page, 'fade-input', '6');
  const ending$ = page.getByTestId('timeline-ending');
  await expect(ending$).toBeVisible();
  const box = (await page.getByTestId('timeline').boundingBox())!;
  const dim = (await ending$.locator('.tl-dim').boundingBox())!;
  const ramp = (await ending$.locator('.tl-ramp').boundingBox())!;
  expect(dim.x - box.x).toBeCloseTo((box.width * 30) / natural, 0);
  expect(ramp.width).toBeCloseTo((box.width * 6) / natural, 0);
  expect(ramp.x - box.x).toBeCloseTo((box.width * 24) / natural, 0);
  expect(dim.x + dim.width).toBeCloseTo(box.x + box.width, 0);
  // the real ending with a fade: a ramp, nothing dimmed
  await page.getByTestId('ending-real').check();
  await expect(ending$.locator('.tl-dim')).toHaveCount(0);
  await expect(ending$.locator('.tl-ramp')).toHaveCount(1);
});

test('the live preview is the export across the fade and the end (same samples as renderRange)', async ({ page }) => {
  test.setTimeout(180_000);
  await setUp(page);
  await addLoop(page, 8, 16, { smooth: false, repeats: 3 });
  await page.getByTestId('ending-at').check();
  await fill(page, 'end-at-input', '0:41.5');
  await fill(page, 'fade-input', '9');
  const capture = await page.evaluate(
    () =>
      (window as unknown as { songLooper: { captureExtendedPreview(o: { fromSeconds: number; seconds: number }): Promise<{ maxDifference: number; peak: number; firstDifferent: number }> } }).songLooper.captureExtendedPreview({
        fromSeconds: 28,
        seconds: 13.5,
      }),
  );
  expect(capture.peak).toBeGreaterThan(0.01);
  expect(capture.maxDifference).toBe(0);
});

test('End exactly at target: the repeats reach the target, the song is trimmed to it, and it follows the target', async ({ page }) => {
  test.setTimeout(180_000);
  const { duration } = await setUp(page);
  await addLoop(page, 8, 16, { smooth: false });
  await expect(page.getByTestId('end-at-target')).toBeHidden();
  await page.getByTestId('length-mode-target').check();
  await expect(page.getByTestId('end-at-target')).toBeVisible();
  // 32.5 + 8 (r - 1): the closest to 1:30 is 88.5 (8 plays); at least 1:30 is 96.5 (9 plays)
  await fill(page, 'target-input', '1:30');
  let [loop] = await appState<{ repeats: number }[]>(page, 's.regions');
  expect(loop!.repeats).toBe(8);
  expect(duration + 7 * 8).toBeLessThan(90);
  expect(duration + 8 * 8).toBeGreaterThan(90);
  await expect(page.getByTestId('length-extended')).toHaveText('1:29');
  await page.getByTestId('end-at-target').click();
  [loop] = await appState<{ repeats: number }[]>(page, 's.regions');
  expect(loop!.repeats).toBe(9); // 96.5 s of song, trimmed to 90
  expect(await ending(page)).toEqual({ endAt: 90, fadeSeconds: 0 });
  await expect(page.getByTestId('length-extended')).toHaveText('1:30.000');
  await expect(page.getByTestId('length-note')).toContainText('Hits the target');
  await expect(page.getByTestId('end-at-follows')).toBeVisible();
  await expect(page.getByTestId('ending-at')).toBeChecked();
  // with a fade that lands on it
  await fill(page, 'fade-input', '4');
  const wav = await exportWav(page);
  expect(frames(wav)).toBe(90 * 44100);
  expect(Math.max(...Array.from({ length: 16 }, (_, i) => Math.abs(left(wav, frames(wav) - 1 - i))))).toBeLessThanOrEqual(6);
  // a new target moves the end point with it (and picks the repeats again)
  await fill(page, 'target-input', '2:00');
  expect((await ending(page)).endAt).toBe(120);
  [loop] = await appState<{ repeats: number }[]>(page, 's.regions');
  expect(duration + (loop!.repeats - 1) * 8).toBeGreaterThanOrEqual(120);
  expect(duration + (loop!.repeats - 1) * 8).toBeLessThan(128);
  await expect(page.getByTestId('length-extended')).toHaveText('2:00.000');
  // typing an End at of its own lets go of the target
  await fill(page, 'end-at-input', '1:50');
  await expect(page.getByTestId('end-at-follows')).toBeHidden();
  await fill(page, 'target-input', '2:30');
  expect((await ending(page)).endAt).toBe(110);
});

test('the WAV limit and the long-song limits use the final length: End at brings a 22-hour plan back under it', async ({ page }) => {
  await setUp(page);
  await addLoop(page, 8, 16, { smooth: false });
  await page.getByTestId('repeats').first().fill('9999');
  await page.getByTestId('repeats').first().press('Enter');
  await expect(page.getByTestId('length-note')).toContainText('Too long for a WAV');
  await expect(page.getByTestId('export')).toBeDisabled();
  await page.getByTestId('ending-at').check();
  await fill(page, 'end-at-input', '1:00:00');
  expect((await ending(page)).endAt).toBe(3600);
  await expect(page.getByTestId('length-extended')).toHaveText('1:00:00.000');
  await expect(page.getByTestId('length-note')).not.toContainText('Too long for a WAV');
  await expect(page.getByTestId('export')).toBeEnabled();
  // the export dialog sizes the file by the end point: 1 h of 16-bit stereo 44.1 kHz is about 605 MiB
  await page.getByTestId('export').click();
  await expect(page.getByTestId('export-estimate')).toContainText(/About 60\d\.\d MB \u00b7 1:00:00/);
  await page.keyboard.press('Escape');
  // End at can be typed beyond what the plan reaches only up to the plan: the plan's own length is the limit
  await fill(page, 'end-at-input', '30:00:00');
  expect(await message(page, 'end-at-input')).toContain('End at must be before that.');
});
