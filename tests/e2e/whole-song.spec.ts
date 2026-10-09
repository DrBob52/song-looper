import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { sine } from '../fixtures/synth';
import { formatClock, formatTime } from '../../src/util/time';
import { appState, decodeInBrowser, loadFixture, makeChordFixture, parseWav, waitForAnalysis, wavFixture } from './helpers';

// SPEC-v1.4.md 3 and 4: "Loop the whole song". An 8-bar intro, the body A B A B C A and a 4-bar outro (the same song as
// tests/unit/wholeSong.test.ts), so the options start just after the intro and end just before the outro.

interface Option {
  start: number;
  end: number;
  bars: number;
  score: number;
  skipsIntro: number;
  skipsOutro: number;
  reason: string;
  components: { coverage: number };
}
interface Reg {
  id: string;
  start: number;
  end: number;
  repeats: number;
  wholeSong?: boolean;
}

const SONG = {
  progressions: { I: 'E B C#m A E B C#m A', A: 'C G Am F', B: 'Dm Em F G', C: 'Am F C G', O: 'Ab Fm Db Eb' },
  structure: 'IABABCAO',
  timbre: { I: 'sine', O: 'square' },
  hats: { A: true, B: true, C: true },
} as const;

const app = (page: Page) => ({
  addLoop: (start: number, end: number) =>
    page.evaluate(([a, b]) => (window as unknown as { songLooper: { addLoop(s: object): string | null } }).songLooper.addLoop({ start: a!, end: b! }), [start, end]),
  addCut: (start: number, end: number) =>
    page.evaluate(([a, b]) => (window as unknown as { songLooper: { addCut(s: object): string | null } }).songLooper.addCut({ start: a!, end: b! }), [start, end]),
});

async function setUp(page: Page): Promise<{ duration: number; options: Option[] }> {
  const fixture = await makeChordFixture(SONG, 'intro-body-outro.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const options = await appState<Option[]>(page, 's.analysis.wholeSong');
  return { duration: fixture.duration, options };
}

const openPanel = async (page: Page): Promise<void> => {
  await page.getByTestId('whole-song').click();
  await expect(page.getByTestId('whole-song-panel')).toBeVisible();
};

test('the panel lists one to three options with times, skipped time and a reason; Audition jump plays', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => {
    errors.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  const { duration, options } = await setUp(page);

  // closed until asked for; the button names what it controls
  const button = page.getByTestId('whole-song');
  await expect(button).toHaveText('↻ Whole song');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('whole-song-panel')).toBeHidden();
  await openPanel(page);
  await expect(button).toHaveAttribute('aria-expanded', 'true');

  const rows = page.getByTestId('whole-song-option');
  const n = await rows.count();
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(3);
  expect(n).toBe(options.length);
  // the best one starts just after the intro (16 s) and ends just before the outro (64 s), within a bar (2 s)
  const top = options[0]!;
  expect(Math.abs(top.start - 16)).toBeLessThanOrEqual(2);
  expect(Math.abs(top.end - 64)).toBeLessThanOrEqual(2);
  expect(top.components.coverage).toBeGreaterThanOrEqual(0.6);
  await expect(rows.first()).toContainText('Option 1');
  await expect(rows.first()).toContainText(`plays ${formatClock(top.start)} → ${formatClock(top.end)}`);
  await expect(rows.first()).toContainText(`keeps ${Math.round(top.components.coverage * 100)}%`);
  await expect(rows.first()).toContainText('skips the first');
  await expect(rows.first()).toContainText('of each repeat');
  await expect(rows.first()).toContainText(top.reason);
  expect(top.skipsIntro).toBeCloseTo(top.start, 6);
  expect(top.skipsOutro).toBeCloseTo(duration - top.end, 6);

  // hovering an option shows its span on the waveform
  await rows.first().hover();
  await expect(page.locator('[data-region-id=highlight]')).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(page.locator('[data-region-id=highlight]')).toHaveCount(0);

  // Audition jump plays the seam snippet (8 s: 4 s before the end point, 4 s from the start point), then stops by itself
  await rows.first().getByTestId('whole-song-audition').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  // nothing was added by listening
  expect(await appState<Reg[]>(page, 's.regions')).toHaveLength(0);

  // it closes again
  await button.click();
  await expect(page.getByTestId('whole-song-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Use this adds a Whole song loop with 2 plays that says Plays, and the extended length and the export are right', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { duration, options } = await setUp(page);
  const top = options[0]!;
  await openPanel(page);
  await page.getByTestId('whole-song-option').first().getByTestId('whole-song-use').click();

  const [region] = await appState<Reg[]>(page, 's.regions');
  expect(region!.start).toBeCloseTo(top.start, 6);
  expect(region!.end).toBeCloseTo(top.end, 6);
  expect(region!.repeats).toBe(2);
  expect(region!.wholeSong).toBe(true);
  // the card: labelled, and its repeat field reads Plays
  const card = page.locator('[data-testid=regions] li').first();
  await expect(card.getByTestId('whole-song-tag')).toHaveText('Whole song');
  await expect(card.locator('.region-settings .field').first()).toContainText('Plays');
  await expect(card.locator('.region-settings .field').first()).not.toContainText('Repeats');
  await expect(card.getByTestId('repeats')).toHaveValue('2');
  await expect(card.getByTestId('repeats-inc')).toHaveAttribute('aria-label', 'More plays');
  // the option now reads Added, and can't be added twice
  await expect(page.getByTestId('whole-song-option').first().getByTestId('whole-song-use')).toHaveText('Added');
  await expect(page.getByTestId('whole-song-option').first().getByTestId('whole-song-use')).toBeDisabled();

  // an ordinary loop otherwise: the extended length is D + (plays - 1) * (end - start)
  const once = region!.end - region!.start;
  const clock = (s: number): string => formatTime(s);
  await expect(page.getByTestId('length-extended')).toHaveText(clock(duration + once));
  await card.getByTestId('repeats').fill('3');
  await card.getByTestId('repeats').press('Enter');
  await expect(page.getByTestId('length-extended')).toHaveText(clock(duration + 2 * once));
  await card.getByTestId('repeats-dec').click();
  await expect(card.getByTestId('repeats')).toHaveValue('2');

  // and so it is exported: the smoothed seam is in first
  await expect(card.getByTestId('seam-summary')).toBeVisible();
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const wav = readFileSync(await download.path());
  const expected = duration + once;
  expect(Math.abs(parseWav(wav).duration - expected)).toBeLessThan(0.02);
  const decoded = await decodeInBrowser(page, wav);
  expect(Math.abs(decoded.duration - expected)).toBeLessThan(0.02);
  expect(decoded.peak).toBeGreaterThan(0.2);
  expect(errors).toEqual([]);
});

test('it is an ordinary loop: typed times, Smooth seam, and a target length solves the number of plays', async ({ page }) => {
  const { duration, options } = await setUp(page);
  const top = options[0]!;
  await openPanel(page);
  await page.getByTestId('whole-song-option').first().getByTestId('whole-song-use').click();
  const card = page.locator('[data-testid=regions] li').first();
  // the seam is smoothed like any loop's (the chip and the summary appear)
  await expect(card.getByTestId('seam-chip')).toBeVisible();
  await expect(card.getByTestId('smooth-toggle')).toBeChecked();
  // typed times work, and stay a whole-song loop while they cover most of the song
  await card.getByTestId('loop-start').fill(formatClock(top.start + 0.5));
  await card.getByTestId('loop-start').press('Enter');
  const [moved] = await appState<Reg[]>(page, 's.regions');
  expect(moved!.start).toBeCloseTo(top.start + 0.5, 3);
  await expect(card.getByTestId('whole-song-tag')).toBeVisible();
  // "make it 30 minutes": the plays are solved to reach it
  await page.getByTestId('length-mode-target').check();
  await page.getByTestId('target-input').fill('30:00');
  await page.getByTestId('target-input').press('Enter');
  const [solved] = await appState<Reg[]>(page, 's.regions');
  const once = solved!.end - solved!.start;
  const ext = duration + (solved!.repeats - 1) * once;
  expect(solved!.repeats).toBeGreaterThan(30);
  expect(Math.abs(ext - 1800)).toBeLessThanOrEqual(once / 2 + 0.05);
  await expect(card.getByTestId('repeats')).toBeDisabled();
  await expect(card.locator('.region-settings .field').first()).toContainText('Plays');
});

test('a loop that no longer covers most of the song drops its label and says Repeats again', async ({ page }) => {
  await setUp(page);
  await openPanel(page);
  await page.getByTestId('whole-song-option').first().getByTestId('whole-song-use').click();
  const card = page.locator('[data-testid=regions] li').first();
  await expect(card.getByTestId('whole-song-tag')).toBeVisible();
  const [r] = await appState<Reg[]>(page, 's.regions');
  await card.getByTestId('loop-end').fill(formatClock(r!.start + 10));
  await card.getByTestId('loop-end').press('Enter');
  await expect(card.getByTestId('whole-song-tag')).toBeHidden();
  await expect(card.locator('.region-settings .field').first()).toContainText('Repeats');
});

test('loops inside an option are replaced only after an in-page confirmation (no confirm dialog)', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const { options } = await setUp(page);
  const top = options[0]!;
  // two loops inside the option's span
  expect(await app(page).addLoop(top.start + 2, top.start + 10)).not.toBeNull();
  expect(await app(page).addLoop(top.start + 16, top.start + 24)).not.toBeNull();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(2);
  await openPanel(page);
  const first = page.getByTestId('whole-song-option').first();
  await expect(first.getByTestId('whole-song-conflict')).toHaveText('This replaces Loop 1 and Loop 2');
  await expect(first.getByTestId('whole-song-use')).toBeEnabled();

  // Use this asks first; Keep them leaves everything as it was
  await first.getByTestId('whole-song-use').click();
  await expect(first.getByTestId('whole-song-confirm')).toBeVisible();
  await expect(first).toContainText('Replace Loop 1 and Loop 2?');
  expect(await appState<Reg[]>(page, 's.regions')).toHaveLength(2);
  await first.getByTestId('whole-song-cancel').click();
  await expect(first.getByTestId('whole-song-confirm')).toBeHidden();
  expect(await appState<Reg[]>(page, 's.regions')).toHaveLength(2);

  // confirming removes them and adds the whole-song loop
  await first.getByTestId('whole-song-use').click();
  await first.getByTestId('whole-song-confirm').click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  const regions = await appState<Reg[]>(page, 's.regions');
  expect(regions).toHaveLength(1);
  expect(regions[0]!.wholeSong).toBe(true);
  expect(regions[0]!.start).toBeCloseTo(top.start, 6);
  expect(regions[0]!.repeats).toBe(2);
  // a loop outside it is not touched: the others (if any are left to offer) still read as options
  expect(dialogs).toEqual([]);
});

test('a loop outside the option is kept, and a loop in it is not removed silently', async ({ page }) => {
  const { options } = await setUp(page);
  const top = options[0]!;
  // inside the intro: outside the option
  expect(await app(page).addLoop(2, 8)).not.toBeNull();
  await openPanel(page);
  const first = page.getByTestId('whole-song-option').first();
  await expect(first.getByTestId('whole-song-conflict')).toHaveCount(0);
  await first.getByTestId('whole-song-use').click();
  await expect(first.getByTestId('whole-song-confirm')).toHaveCount(0);
  const regions = await appState<Reg[]>(page, 's.regions');
  expect(regions).toHaveLength(2);
  expect(regions.map((r) => r.wholeSong === true)).toEqual([false, true]);
  expect(regions[0]!.end).toBeLessThanOrEqual(top.start + 1e-6);
  // the second card says Plays, the first Repeats
  const cards = page.locator('[data-testid=regions] li');
  await expect(cards.nth(0).locator('.region-settings .field').first()).toContainText('Repeats');
  await expect(cards.nth(1).locator('.region-settings .field').first()).toContainText('Plays');
});

test('a cut inside an option disables it and names the cut; a cut outside is fine', async ({ page }) => {
  const { options } = await setUp(page);
  const top = options[0]!;
  const at = top.start + 24.2;
  expect(await app(page).addCut(at, at + 2)).not.toBeNull();
  await openPanel(page);
  const rows = page.getByTestId('whole-song-option');
  const first = rows.first();
  await expect(first.getByTestId('whole-song-conflict')).toHaveText(`Remove the cut at ${formatClock(at)} first`);
  await expect(first.getByTestId('whole-song-use')).toBeDisabled();
  // Audition still works on a blocked option
  await expect(first.getByTestId('whole-song-audition')).toBeEnabled();
  // removing the cut enables it
  await page.getByTestId('remove-cut').first().click();
  await expect(first.getByTestId('whole-song-conflict')).toHaveCount(0);
  await expect(first.getByTestId('whole-song-use')).toBeEnabled();
  // a cut in the intro (outside the option) does not matter, and stays
  expect(await app(page).addCut(1, 3)).not.toBeNull();
  await expect(first.getByTestId('whole-song-use')).toBeEnabled();
  await first.getByTestId('whole-song-use').click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  expect(await appState<unknown[]>(page, 's.cuts')).toHaveLength(1);
});

test('the panel says why when there is nothing to offer: a short song, and a song with no steady beat', async ({ page }) => {
  const short = await wavFixture([sine(220, 12, 44100, 0.4)], 44100, 'short.wav');
  await loadFixture(page, short);
  await waitForAnalysis(page);
  await openPanel(page);
  await expect(page.getByTestId('whole-song-note')).toHaveText('The song is too short to loop as a whole');
  await expect(page.getByTestId('whole-song-option')).toHaveCount(0);

  const tone = await wavFixture([sine(220, 40, 44100, 0.4)], 44100, 'tone.wav');
  await loadFixture(page, tone);
  await waitForAnalysis(page);
  await openPanel(page);
  await expect(page.getByTestId('whole-song-note')).toHaveText(
    'No steady beat found. Drag a selection from just after the intro to just before the outro and press L.',
  );
  await expect(page.getByTestId('whole-song-option')).toHaveCount(0);
  // and the way out it names works: a selection and L
  await page.evaluate(() => (window as unknown as { songLooper: { store: { set(p: object): void } } }).songLooper.store.set({ selection: { start: 3, end: 35 } }));
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
});
