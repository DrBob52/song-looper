import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { appState, clickTrackFixture, loadFixture, makeChordFixture, waitForAnalysis } from './helpers';

// SPEC-v1.2.md sections 3 and 4: every adjustable number is a NumberField paired with its slider or stepper,
// and the play/pause is large and obvious.

async function addLoop(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ([a, b]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({
        start: a!,
        end: b!,
      }),
    [start, end],
  );
}

const invalid = (page: Page, testId: string) => expect(page.getByTestId(testId)).toHaveAttribute('aria-invalid', 'true');

test('repeats: typed, stepped, held to accelerate, and refused out of range', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await addLoop(page, 0, 8);
  const repeats = page.getByTestId('repeats').first();
  const count = (): Promise<number> => appState<number>(page, 's.regions[0].repeats');

  await repeats.fill('7');
  await repeats.press('Enter');
  expect(await count()).toBe(7);
  await expect(repeats).toHaveValue('7');
  await repeats.press('ArrowUp');
  expect(await count()).toBe(8);
  await repeats.press('Shift+ArrowUp');
  expect(await count()).toBe(18);
  await repeats.press('ArrowDown');
  expect(await count()).toBe(17);
  await page.getByTestId('repeats-inc').first().click();
  expect(await count()).toBe(18);
  await page.getByTestId('repeats-dec').first().click();
  await page.getByTestId('repeats-dec').first().click();
  expect(await count()).toBe(16);

  // never below 1
  await repeats.fill('1');
  await repeats.press('Enter');
  await repeats.press('ArrowDown');
  expect(await count()).toBe(1);

  // junk and out-of-range numbers are not committed
  await repeats.fill('2.5');
  await repeats.press('Enter');
  await invalid(page, 'repeats');
  await repeats.fill('0');
  await repeats.press('Enter');
  await invalid(page, 'repeats');
  await repeats.fill('1000000');
  await repeats.press('Enter');
  await invalid(page, 'repeats');
  expect(await count()).toBe(1);
  await repeats.press('Escape');
  await expect(repeats).toHaveValue('1');

  // holding + speeds up: a long press goes well past what single clicks would
  const inc = page.getByTestId('repeats-inc').first();
  const box = (await inc.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2200);
  await page.mouse.up();
  const held = await count();
  expect(held).toBeGreaterThan(30);
  // and the click that ends the hold is not one more step
  await page.waitForTimeout(150);
  expect(await count()).toBe(held);
  expect(errors).toEqual([]);
});

test('speed and pitch: typed values and the slider or stepper stay in sync', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);

  const speed = page.getByTestId('speed-input');
  const pitch = page.getByTestId('pitch-input');
  const slider = page.getByTestId('speed');

  await speed.fill('1.25x');
  await speed.press('Enter');
  expect(await appState<number>(page, 's.speed')).toBe(1.25);
  await expect(slider).toHaveValue('1.25');
  await expect(page.getByTestId('speed-label')).toHaveText('1.25x');
  await expect(speed).toHaveValue('1.25');
  await speed.press('ArrowUp');
  expect(await appState<number>(page, 's.speed')).toBe(1.26);
  await speed.press('Shift+ArrowDown');
  expect(await appState<number>(page, 's.speed')).toBe(1.16);
  await speed.press('Alt+ArrowUp'); // 0.001 is below the 0.01 the app keeps: rounds back
  expect(await appState<number>(page, 's.speed')).toBe(1.16);
  // the slider moves the field
  await slider.fill('0.8');
  await expect(speed).toHaveValue('0.80');
  expect(await appState<number>(page, 's.speed')).toBe(0.8);
  // out of range or junk: not committed
  await speed.fill('2');
  await speed.press('Enter');
  await invalid(page, 'speed-input');
  await speed.fill('fast');
  await speed.press('Enter');
  await invalid(page, 'speed-input');
  expect(await appState<number>(page, 's.speed')).toBe(0.8);
  await speed.press('Escape');
  await expect(speed).toHaveValue('0.80');
  await speed.fill('0.5');
  await speed.press('Enter');
  expect(await appState<number>(page, 's.speed')).toBe(0.5);
  await speed.press('ArrowDown'); // stops at the limit
  expect(await appState<number>(page, 's.speed')).toBe(0.5);

  await pitch.fill('-1.5');
  await pitch.press('Enter');
  expect(await appState<number>(page, 's.pitch')).toBe(-1.5);
  await expect(page.getByTestId('pitch-label')).toHaveText('-1.5');
  await pitch.press('ArrowUp');
  expect(await appState<number>(page, 's.pitch')).toBe(-1.4);
  await pitch.press('Shift+ArrowUp');
  expect(await appState<number>(page, 's.pitch')).toBe(-0.4);
  await pitch.press('Alt+ArrowDown');
  expect(await appState<number>(page, 's.pitch')).toBe(-0.41);
  await page.getByTestId('pitch-up').click();
  expect(await appState<number>(page, 's.pitch')).toBe(0.59);
  await expect(pitch).toHaveValue('+0.59');
  await pitch.fill('13');
  await pitch.press('Enter');
  await invalid(page, 'pitch-input');
  expect(await appState<number>(page, 's.pitch')).toBe(0.59);
  await pitch.press('Escape');

  // a fractional pitch and a typed speed really play (through the SoundTouch worklet), also while changing
  await pitch.fill('-1.5');
  await pitch.press('Enter');
  await speed.fill('1.1');
  await speed.press('Enter');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.waitForTimeout(500);
  await pitch.fill('2.25');
  await pitch.press('Enter');
  await page.waitForTimeout(300);
  const t = await page.evaluate(() => (window as unknown as { songLooper: { player: { getTime(): number } } }).songLooper.player.getTime());
  expect(t).toBeGreaterThan(0.3);
  await page.getByTestId('play').click();
  expect(errors).toEqual([]);
});

test('tempo, bar line and zoom can be typed; the seam fade field follows its slider', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);

  // tempo: typing a BPM overrides the detected one, like the half/double menu
  const bpm = page.getByTestId('bpm-input');
  await expect(bpm).toHaveValue(/^1[12]\d\.\d$/);
  await bpm.fill('60');
  await bpm.press('Enter');
  await expect.poll(() => appState<number | null>(page, 's.analysis.bpmOverride')).toBe(60);
  await waitForAnalysis(page);
  await expect(bpm).toHaveValue('60.0');
  // the clicks are 0.5 s apart; at 60 BPM the beats are every other click
  const beats = await appState<number[]>(page, 's.analysis.beats');
  const spacing = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
  expect(spacing).toBeGreaterThan(0.9);
  expect(spacing).toBeLessThan(1.1);
  await bpm.fill('20');
  await bpm.press('Enter');
  await invalid(page, 'bpm-input');
  await bpm.fill('301');
  await bpm.press('Enter');
  await invalid(page, 'bpm-input');
  await bpm.press('Escape');
  await expect(bpm).toHaveValue('60.0');

  // bar line: absolute position 0..beatsPerBar-1
  const shift = page.getByTestId('bar-shift-input');
  const phase0 = await appState<number>(page, 's.analysis.barPhase');
  const target = (phase0 + 2) % 4;
  await shift.fill(String(target));
  await shift.press('Enter');
  await expect.poll(() => appState<number>(page, 's.analysis.barPhase')).toBe(target);
  await expect(shift).toHaveValue(String(target));
  await page.getByTestId('bar-shift-right').click();
  await expect.poll(() => appState<number>(page, 's.analysis.barPhase')).toBe((target + 1) % 4);
  await expect(shift).toHaveValue(String((target + 1) % 4));
  await shift.fill('4');
  await shift.press('Enter');
  await invalid(page, 'bar-shift-input');
  await shift.fill('1.5');
  await shift.press('Enter');
  await invalid(page, 'bar-shift-input');
  await shift.press('Escape');

  // zoom: px per second, with the slider kept in step
  const zoom = page.getByTestId('zoom-input');
  await expect(zoom).toHaveValue('fit');
  await zoom.fill('80');
  await zoom.press('Enter');
  expect(await appState<number>(page, 's.zoom')).toBe(80);
  const sliderValue = Number(await page.getByTestId('zoom').inputValue());
  expect(sliderValue).toBeCloseTo((100 * Math.log(80 / 10)) / Math.log(40), 0);
  await zoom.press('ArrowUp');
  expect(await appState<number>(page, 's.zoom')).toBe(90);
  await zoom.fill('5');
  await zoom.press('Enter');
  await invalid(page, 'zoom-input');
  await zoom.press('Escape');
  await page.getByTestId('zoom').fill('0');
  await expect(zoom).toHaveValue('fit');
  expect(await appState<number>(page, 's.zoom')).toBe(0);
  await zoom.fill('fit');
  await zoom.press('Enter');
  expect(await appState<number>(page, 's.zoom')).toBe(0);

  // seam fade (Advanced)
  await page.locator('summary', { hasText: 'Advanced' }).click();
  const fade = page.getByTestId('seam-smoothing-input');
  await fade.fill('33');
  await fade.press('Enter');
  expect(await appState<number>(page, 's.seamMs')).toBe(33);
  await expect(page.getByTestId('seam-smoothing')).toHaveValue('33');
  await page.getByTestId('seam-smoothing').fill('45');
  await expect(fade).toHaveValue('45');
  expect(await appState<number>(page, 's.seamMs')).toBe(45);
  await fade.fill('200');
  await fade.press('Enter');
  await invalid(page, 'seam-smoothing-input');
  expect(await appState<number>(page, 's.seamMs')).toBe(45);
  expect(errors).toEqual([]);
});

test('target length is typed as m:ss or h:mm:ss', async ({ page }) => {
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await addLoop(page, 0, 8);
  await page.getByTestId('length-mode-target').check();
  const target = page.getByTestId('target-input');
  await target.fill('0:01:40');
  await target.press('Enter');
  await expect(page.getByTestId('length-note')).toContainText('Closest whole repeats');
  await expect(target).toHaveValue('1:40');
  const [r] = await appState<{ repeats: number }[]>(page, 's.regions');
  expect(Math.abs(fixture.duration + (r!.repeats - 1) * 8 - 100)).toBeLessThanOrEqual(4 + 0.05);
  await target.press('ArrowUp');
  expect(await appState<number>(page, 's.targetSeconds')).toBe(101);
  await target.press('Shift+ArrowUp');
  expect(await appState<number>(page, 's.targetSeconds')).toBe(111);
  await target.fill('1:75');
  await target.press('Enter');
  await invalid(page, 'target-input');
  await target.fill('0');
  await target.press('Enter');
  await invalid(page, 'target-input');
});

test('the play/pause is large and obvious, Space still toggles it, and every loop row has its own play button', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  const play = page.getByTestId('play');
  const box = (await play.locator('.record').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(64);
  expect(box.height).toBeGreaterThanOrEqual(64);
  expect(Math.abs(box.width - box.height)).toBeLessThan(1);
  const radius = await play.locator('.record-disc').evaluate((el) => getComputedStyle(el).borderRadius);
  expect(radius).toMatch(/50%|3[2-9]px|[4-9]\d+px/);
  await expect(play).toHaveText('Play');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await play.click();
  await expect(play).toHaveText('Pause');
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(play).toHaveText('Play');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  await expect(play).toHaveText('Pause');
  await page.keyboard.press('Space');
  await expect(play).toHaveText('Play');

  // loop rows: a play button each, which plays that loop on repeat
  await addLoop(page, 0, 8);
  await addLoop(page, 16, 24);
  await expect(page.getByTestId('loop-preview')).toHaveCount(2);
  const second = page.getByTestId('loop-preview').nth(1);
  const sBox = (await second.boundingBox())!;
  expect(sBox.width).toBeGreaterThanOrEqual(32);
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  await second.click();
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(second).toHaveText('Stop');
  await expect(page.getByTestId('loop-preview').first()).toHaveAttribute('aria-pressed', 'false');
  await expect(play).toHaveText('Pause');
  const id = await appState<string>(page, 's.regions[1].id');
  expect(await appState<string>(page, 's.previewingId')).toBe(id);
  await second.click();
  await expect(second).toHaveText('Loop');
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('the play button stays at least 56 px on a phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 380, height: 800 } });
  const page = await context.newPage();
  const fixture = await clickTrackFixture(120, 20);
  await loadFixture(page, fixture);
  const box = (await page.getByTestId('play').locator('.record').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(56);
  expect(box.height).toBeGreaterThanOrEqual(56);
  await context.close();
});
