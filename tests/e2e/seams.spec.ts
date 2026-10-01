import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { appState, loadFixture, makeChordFixture, parseWav, waitForAnalysis } from './helpers';

/** The extended length shown in the length panel, in seconds (it shows whole seconds). */
async function shownLength(page: Page): Promise<number> {
  const text = (await page.getByTestId('length-extended').textContent()) ?? '';
  const [m, sec] = text.trim().split(':').map(Number);
  return m! * 60 + sec!;
}

/** Add a loop on a span of the song through the app (as the Add button would). */
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

test('the seam chip reads Rough for a loop whose chord change is not in the song, and not for one that is', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const [a, b] = fixture.sections;

  // Loop A (C G Am F) ends on F and returns to C: the song never makes that change.
  await addLoop(page, a!.start, a!.end);
  const chip = page.getByTestId('seam-chip').first();
  await expect(chip).toHaveText('Rough');
  await expect(chip).toHaveAttribute('data-chip', 'rough');
  await expect(chip).toHaveAttribute('title', /never makes this chord change/);

  // Loop A+B ends on G and returns to C, which the song does at the end of its first B.
  await page.getByTestId('remove-loop').click();
  await addLoop(page, a!.start, b!.end);
  await expect(page.getByTestId('seam-chip').first()).not.toHaveText('Rough');
  await expect(page.getByTestId('seam-chip').first()).toHaveAttribute('title', /makes this chord change itself/);

  // moving a loop's edge asks again
  await page.getByTestId('remove-loop').click();
  await addLoop(page, a!.start, a!.end);
  await expect(page.getByTestId('seam-chip').first()).toHaveText('Rough');
  expect(errors).toEqual([]);
});

interface SeamState {
  start: number;
  end: number;
  repeats: number;
  smooth?: boolean;
  seam?: { shift: number; align: number; loopStart: number; loopEnd: number; jumps: { fadeMs?: number }[] };
}

test('smooth seam: on by default, shows what moved, Undo restores the loop, Hear original plays the raw seam, export matches the timeline', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const [a] = fixture.sections;

  await addLoop(page, a!.start, a!.end);
  const region = async (): Promise<SeamState> => (await appState<SeamState[]>(page, 's.regions'))[0]!;

  // smoothing is on by default: a plan arrives, with a one-line summary
  const summary = page.getByTestId('seam-summary').first();
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText(/Seam (moved|kept).*fade \d+ ms/);
  await expect(page.getByTestId('smooth-toggle').first()).toBeChecked();
  let r = await region();
  expect(r.seam).toBeTruthy();
  // the loop's own points are the ones the user set
  expect(r.start).toBe(a!.start);
  expect(r.end).toBe(a!.end);
  // the rotation moves both edges by up to a beat; the fade of a seam with poor harmony is at most 40 ms
  expect(Math.abs(r.seam!.shift)).toBeLessThanOrEqual(0.5 + 1e-6);
  expect(r.seam!.jumps[0]!.fadeMs!).toBeLessThanOrEqual(40);
  expect(Math.abs(r.seam!.align)).toBeLessThanOrEqual(0.02 + 1e-9);
  await expect(page.getByTestId('seam-chip').first()).toHaveText('Rough');

  // the audition plays the smoothed seam, Hear original the raw one
  await page.getByTestId('audition-seam').first().click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  await page.getByTestId('audition-original').first().click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');

  // export: the file is as long as the timeline says (the aligned end edge changes each repeat by a few ms at most)
  await page.getByTestId('repeats').first().fill('3');
  await page.getByTestId('repeats').first().press('Enter');
  r = await region();
  const loop = r.seam!.loopEnd - r.seam!.loopStart;
  const expected = fixture.duration + 2 * loop;
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const wav = readFileSync(await download.path());
  expect(Math.abs(parseWav(wav).duration - expected)).toBeLessThan(0.02);
  await expect(page.getByTestId('length-extended')).toContainText(`${Math.floor(expected / 60)}:`);

  // Undo: the original seam, smoothing off for this loop, the points exactly as they were
  await page.getByTestId('seam-undo').first().click();
  await expect(page.getByTestId('seam-summary').first()).toBeHidden();
  await expect(page.getByTestId('smooth-toggle').first()).not.toBeChecked();
  r = await region();
  expect(r.seam).toBeUndefined();
  expect(r.smooth).toBe(false);
  expect(r.start).toBe(a!.start);
  expect(r.end).toBe(a!.end);
  await expect(page.getByTestId('seam-chip').first()).toHaveText('Rough');

  // turning it back on smooths again
  await page.getByTestId('smooth-toggle').first().check();
  await expect(page.getByTestId('seam-summary').first()).toBeVisible();
  await expect(page.getByTestId('seam-summary').first()).toHaveText(/Seam (moved|kept)/);
  expect((await region()).seam).toBeTruthy();
  expect(errors).toEqual([]);
});

test('a loop with a poor chord change is offered a cleaner one nearby: Audition plays it, Use switches to it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const bar = 2;

  // bars 1-7 of C G Am F Dm Em F G end on F and return to C: not a change the song makes
  await addLoop(page, 0, 7 * bar);
  const nearby = page.getByTestId('nearby').first();
  await expect(nearby).toBeVisible();
  await expect(page.getByTestId('nearby-text').first()).toHaveText(/Cleaner chord change nearby: 0:00\.\d.0:1[56]\.\d \(8 bars\)/);
  await expect(page.getByTestId('seam-chip').first()).toHaveText('Rough');

  // it is only a suggestion: nothing moves until the user clicks
  let [region] = await appState<{ start: number; end: number }[]>(page, 's.regions');
  expect(region!.start).toBe(0);
  expect(region!.end).toBe(7 * bar);

  await page.getByTestId('nearby-audition').first().click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  [region] = await appState<{ start: number; end: number }[]>(page, 's.regions');
  expect(region!.end).toBe(7 * bar);

  await page.getByTestId('nearby-use').first().click();
  await expect.poll(async () => (await appState<{ end: number }[]>(page, 's.regions'))[0]!.end).toBeGreaterThan(15.9);
  [region] = await appState<{ start: number; end: number }[]>(page, 's.regions');
  expect(region!.start).toBeLessThan(0.1);
  expect(region!.end).toBeLessThan(16.1);
  // the new loop's chord change (G back to C) is in the song: no more suggestion, and the chip agrees
  await expect(page.getByTestId('seam-chip').first()).not.toHaveText('Rough');
  await expect(page.getByTestId('nearby').first()).toBeHidden();
  expect(errors).toEqual([]);
});

test('bridge: opt-in per loop; the chip improves, the timeline strip hatches it, the export matches the timeline', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const [a] = fixture.sections;

  await addLoop(page, a!.start, a!.end);
  const chip = page.getByTestId('seam-chip').first();
  await expect(chip).toHaveText('Rough');
  // off by default, with a hint on a rough seam
  await expect(page.getByTestId('bridge-toggle').first()).not.toBeChecked();
  await expect(page.getByTestId('bridge-hint').first()).toBeVisible();
  await expect(page.getByTestId('bridge-hint').first()).toHaveText('Seam sounds rough? Try Bridge');
  await expect(page.getByTestId('bridge-status').first()).toBeHidden();
  expect(await page.locator('.tl-block.bridge').count()).toBe(0);
  const repeatsInput = page.getByTestId('repeats').first();
  await repeatsInput.fill('3');
  await repeatsInput.press('Enter');
  const plainExpected = fixture.duration + 2 * (a!.end - a!.start);
  // (the panel shows whole seconds)
  await expect.poll(async () => Math.abs((await shownLength(page)) - plainExpected)).toBeLessThanOrEqual(0.51);

  // turn the bridge on: 4 bars of the song's own B section, then back where G -> C is
  await page.getByTestId('bridge-toggle').first().check();
  const status = page.getByTestId('bridge-status').first();
  await expect(status).toHaveText(/^Bridge: 4 bars from 0:08\.\d, back at 0:16\.\d \(chord change found there\)$/);
  await expect(chip).not.toHaveText('Rough');
  await expect(page.getByTestId('bridge-hint').first()).toBeHidden();

  // the timeline strip: a hatched block after every repeat but the last, and the extended length counts the bridges
  const region = (await appState<{ seam: { loopStart: number; loopEnd: number; bridge: { seconds: number; bars: number } } }[]>(page, 's.regions'))[0]!;
  expect(region.seam.bridge.bars).toBe(4);
  await expect(page.locator('.tl-block.bridge')).toHaveCount(2);
  expect(await page.locator('.tl-block.repeat').count()).toBe(3);
  const expected = fixture.duration + 2 * (region.seam.loopEnd - region.seam.loopStart + region.seam.bridge.seconds);
  await expect.poll(async () => Math.abs((await shownLength(page)) - expected)).toBeLessThanOrEqual(0.51);

  // the audition and the loop preview play the bridge
  await page.getByTestId('audition-seam').first().click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  await page.getByTestId('loop-preview').first().click();
  await expect(page.getByTestId('loop-preview').first()).toHaveText('Stop');
  await page.getByTestId('loop-preview').first().click();
  await expect(page.getByTestId('loop-preview').first()).toHaveText('Loop');

  // export: the WAV is as long as the timeline says
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const wav = readFileSync(await download.path());
  expect(Math.abs(parseWav(wav).duration - expected)).toBeLessThan(0.02);

  // and switching it off puts everything back
  await page.getByTestId('bridge-toggle').first().uncheck();
  await expect(page.locator('.tl-block.bridge')).toHaveCount(0);
  await expect(page.getByTestId('bridge-status').first()).toBeHidden();
  await expect(chip).toHaveText('Rough');
  expect(errors).toEqual([]);
});

test('bridge: a loop whose seam is already natural says no bridge is needed', async ({ page }) => {
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const [a, b] = fixture.sections;
  await addLoop(page, a!.start, b!.end);
  await expect(page.getByTestId('seam-chip').first()).not.toHaveText('Rough');
  await expect(page.getByTestId('bridge-hint').first()).toBeHidden();
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/No bridge needed/);
  await expect(page.locator('.tl-block.bridge')).toHaveCount(0);
});

test('bridge: target-length mode counts the bridge when it picks repeat counts', async ({ page }) => {
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const [a] = fixture.sections;
  await addLoop(page, a!.start, a!.end);
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/^Bridge: 4 bars/);

  await page.getByTestId('length-mode-target').check();
  await page.getByTestId('target-input').fill('2:00');
  await page.getByTestId('target-input').press('Enter');
  await expect(page.getByTestId('length-note')).toContainText('Closest whole repeats');
  const r = (await appState<{ repeats: number; seam: { loopStart: number; loopEnd: number; bridge: { seconds: number } } }[]>(page, 's.regions'))[0]!;
  const cycle = r.seam.loopEnd - r.seam.loopStart + r.seam.bridge.seconds;
  const total = fixture.duration + (r.repeats - 1) * cycle;
  // within half a (loop + bridge) of the target, as the solver promises
  expect(Math.abs(total - 120)).toBeLessThanOrEqual(cycle / 2 + 0.05);
  // a plain loop would need more repeats for the same time
  expect(r.repeats).toBeLessThan(1 + Math.round((120 - fixture.duration) / (a!.end - a!.start)));
  await expect.poll(async () => Math.abs((await shownLength(page)) - total)).toBeLessThanOrEqual(0.51);
});
