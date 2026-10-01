import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { appState, loadFixture, makeChordFixture, parseWav, waitForAnalysis } from './helpers';

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
