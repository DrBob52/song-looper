import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { appState, loadFixture, makeChordFixture, waitForAnalysis } from './helpers';

// SPEC-v1.2.md section 1: exact loop times, nudges, Set from playhead, I and O.

interface Reg {
  id: string;
  start: number;
  end: number;
  repeats: number;
  smooth?: boolean;
  exact?: boolean;
  seam?: unknown;
}

const regions = (page: Page): Promise<Reg[]> => appState<Reg[]>(page, 's.regions');

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

async function seek(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => (window as unknown as { songLooper: { player: { seek(t: number): void } } }).songLooper.player.seek(t), seconds);
}

/** Left edge and width of a loop's region on the waveform, as fractions of the song. */
async function regionBox(page: Page, id: string): Promise<{ left: number; width: number }> {
  return page.evaluate((regionId) => {
    // wavesurfer draws inside a shadow root (the loop list has rows with the same data attribute)
    const root = document.querySelector('[data-testid=waveform] > div')?.shadowRoot;
    const node = root?.querySelector<HTMLElement>(`[data-region-id="${regionId}"]`);
    if (!node) throw new Error('region not found');
    return { left: parseFloat(node.style.left) / 100, width: 1 - parseFloat(node.style.left) / 100 - parseFloat(node.style.right) / 100 };
  }, id);
}

async function setup(page: Page): Promise<{ duration: number; a: { start: number; end: number }; b: { start: number; end: number } }> {
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  return { duration: fixture.duration, a: fixture.sections[0]!, b: fixture.sections[1]! };
}

test('typing a start and end moves the region, turns Smooth seam off and says so; bad times are refused', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { duration, a, b } = await setup(page);

  await addLoop(page, a.start, a.end);
  await expect(page.getByTestId('seam-summary').first()).toBeVisible();
  await expect(page.getByTestId('smooth-toggle').first()).toBeChecked();
  await expect(page.getByTestId('loop-exact-notice').first()).toBeHidden();
  // the fields show milliseconds
  await expect(page.getByTestId('loop-start').first()).toHaveValue(/^\d+:\d\d\.\d{3}$/);

  const start = page.getByTestId('loop-start').first();
  const end = page.getByTestId('loop-end').first();
  await start.fill('0:02.345');
  await start.press('Enter');
  await end.fill('11.250');
  await end.press('Enter');

  let [r] = await regions(page);
  expect(r!.start).toBe(2.345);
  expect(r!.end).toBe(11.25);
  expect(r!.smooth).toBe(false);
  expect(r!.exact).toBe(true);
  expect(r!.seam).toBeUndefined();
  await expect(start).toHaveValue('0:02.345');
  await expect(end).toHaveValue('0:11.250');
  await expect(page.getByTestId('smooth-toggle').first()).not.toBeChecked();
  await expect(page.getByTestId('seam-summary').first()).toBeHidden();
  await expect(page.getByTestId('loop-exact-notice').first()).toHaveText(
    'Smooth seam is off so the loop plays exactly these times. Turn it back on to let it move the join.',
  );
  await expect(page.getByTestId('loop-length').first()).toContainText('8.905 s');
  // the waveform region moved at once
  const box = await regionBox(page, r!.id);
  expect(box.left).toBeCloseTo(2.345 / duration, 4);
  expect(box.width).toBeCloseTo(8.905 / duration, 4);

  // Smooth seam can be switched back on: the notice goes and the smoother plans the join again
  await page.getByTestId('smooth-toggle').first().check();
  await expect(page.getByTestId('loop-exact-notice').first()).toBeHidden();
  await expect(page.getByTestId('seam-summary').first()).toBeVisible();
  [r] = await regions(page);
  expect(r!.exact).toBe(false);
  expect(r!.start).toBe(2.345); // the smoother plays the loop moved, it does not edit the points

  // End at or before start: refused, with the start in the message, and the loop keeps its times
  await end.fill('0:01.000');
  await end.press('Enter');
  await expect(page.getByTestId('loop-end').first()).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#' + (await end.getAttribute('id')) + '-msg')).toHaveText('End must be after start (0:02.345).');
  [r] = await regions(page);
  expect(r!.end).toBe(11.25);
  // Escape puts the old value back and clears the message
  await end.press('Escape');
  await expect(end).toHaveValue('0:11.250');
  await expect(end).not.toHaveAttribute('aria-invalid', 'true');

  // junk is refused and not committed
  await start.fill('soon');
  await start.press('Enter');
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  expect((await regions(page))[0]!.start).toBe(2.345);
  await start.press('Escape');
  await expect(start).toHaveValue('0:02.345');

  // past the end of the song
  await end.fill(String(duration + 5));
  await end.press('Enter');
  await expect(page.locator('#' + (await end.getAttribute('id')) + '-msg')).toContainText('Past the end of the song');
  await end.press('Escape');

  // overlapping another loop is refused and not clamped
  await addLoop(page, b.start + 4, b.end);
  const rs = await regions(page);
  expect(rs).toHaveLength(2);
  const second = rs[1]!;
  const secondStart = page.getByTestId('loop-start').nth(1);
  await secondStart.fill('0:05.000');
  await secondStart.press('Enter');
  await expect(page.locator('#' + (await secondStart.getAttribute('id')) + '-msg')).toHaveText('Overlaps Loop 1 (0:02.345–0:11.250).');
  expect((await regions(page))[1]!.start).toBe(second.start);
  expect(errors).toEqual([]);
});

test('nudges move an edge by exactly 10 ms or one beat, Set from playhead and the I and O keys use the playhead', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { a } = await setup(page);
  await addLoop(page, a.start + 2, a.end);
  await expect(page.getByTestId('seam-summary').first()).toBeVisible();
  const before = (await regions(page))[0]!;

  await page.getByTestId('start-ms-inc').first().click();
  let r = (await regions(page))[0]!;
  expect(Math.round((r.start - before.start) * 1000)).toBe(10);
  expect(r.smooth).toBe(false);
  await page.getByTestId('start-ms-dec').first().click();
  await page.getByTestId('start-ms-dec').first().click();
  r = (await regions(page))[0]!;
  expect(Math.round((r.start - before.start) * 1000)).toBe(-10);
  await page.getByTestId('end-ms-inc').first().click();
  await page.getByTestId('end-ms-inc').first().click();
  await page.getByTestId('end-ms-inc').first().click();
  r = (await regions(page))[0]!;
  expect(Math.round((r.end - before.end) * 1000)).toBe(30);
  await page.getByTestId('end-ms-dec').first().click();
  r = (await regions(page))[0]!;
  expect(Math.round((r.end - before.end) * 1000)).toBe(20);
  await expect(page.getByTestId('loop-end').first()).toHaveValue(/\.\d{3}$/);

  // one beat is the analysed beat at that point
  const beats = await appState<number[]>(page, 's.grid.beats');
  const beatAt = (t: number): number => {
    let i = 0;
    while (i < beats.length - 2 && beats[i + 1]! <= t) i++;
    return beats[i + 1]! - beats[i]!;
  };
  const e0 = (await regions(page))[0]!.end;
  await page.getByTestId('end-beat-inc').first().click();
  r = (await regions(page))[0]!;
  expect(r.end - e0).toBeCloseTo(beatAt(e0), 2);
  await page.getByTestId('end-beat-dec').first().click();
  expect((await regions(page))[0]!.end).toBeCloseTo(e0, 2);
  const s0 = (await regions(page))[0]!.start;
  await page.getByTestId('start-beat-dec').first().click();
  expect(s0 - (await regions(page))[0]!.start).toBeCloseTo(beatAt(s0 - 0.001), 2);

  // Set from playhead (the playhead is the original song's position)
  await seek(page, 9.1234);
  await page.getByTestId('end-playhead').first().click();
  expect((await regions(page))[0]!.end).toBe(9.123);
  await seek(page, 4.5);
  await page.getByTestId('start-playhead').first().click();
  expect((await regions(page))[0]!.start).toBe(4.5);
  await expect(page.getByTestId('loop-start').first()).toHaveValue('0:04.500');

  // a refused nudge says why and changes nothing
  await seek(page, 9.123 + 0.05);
  await page.getByTestId('start-playhead').first().click();
  await expect(page.locator('#' + (await page.getByTestId('loop-start').first().getAttribute('id')) + '-msg')).toContainText('Start must be before end');
  expect((await regions(page))[0]!.start).toBe(4.5);
  await expect(page.getByTestId('loop-start').first()).toHaveAttribute('aria-invalid', 'true');

  // I and O act on the selected loop
  await seek(page, 3.0);
  await page.keyboard.press('i');
  expect((await regions(page))[0]!.start).toBe(3);
  await seek(page, 10.5);
  await page.keyboard.press('o');
  expect((await regions(page))[0]!.end).toBe(10.5);
  expect((await regions(page))[0]!.smooth).toBe(false);

  // with no loop selected, they set the edges of the selection, and L adds it as a loop
  await page.keyboard.press('Escape');
  expect(await appState<string | null>(page, 's.selectedId')).toBeNull();
  await seek(page, 14.2);
  await page.keyboard.press('i');
  expect(await appState<number>(page, 's.selection.start')).toBe(14.2);
  await seek(page, 20.8);
  await page.keyboard.press('o');
  expect(await appState<number>(page, 's.selection.end')).toBe(20.8);
  expect(await appState<number>(page, 's.selection.start')).toBe(14.2);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(2);
  const added = (await regions(page))[1]!;
  expect(added.start).toBe(14.2);
  expect(added.end).toBe(20.8);
  // the hint lists the keys
  const hint = await page.getByTestId('wave-hint').textContent();
  expect(hint).toMatch(/\bI\b/);
  expect(hint).toMatch(/\bO\b/);
  expect(errors).toEqual([]);
});

test('number fields: arrows step (Shift x10, Alt /10), the wheel never changes a value', async ({ page }) => {
  const { a } = await setup(page);
  await addLoop(page, a.start + 2, a.end);
  const start = page.getByTestId('loop-start').first();
  const s0 = (await regions(page))[0]!.start;
  await start.focus();
  await start.press('ArrowUp');
  expect(Math.round(((await regions(page))[0]!.start - s0) * 1000)).toBe(10);
  await start.press('Shift+ArrowUp');
  expect(Math.round(((await regions(page))[0]!.start - s0) * 1000)).toBe(110);
  await start.press('Alt+ArrowDown');
  expect(Math.round(((await regions(page))[0]!.start - s0) * 1000)).toBe(109);
  await start.press('ArrowDown');
  await start.press('Shift+ArrowDown');
  expect(Math.round(((await regions(page))[0]!.start - s0) * 1000)).toBe(-1);
  // the wheel over a focused field does nothing
  const shown = await start.inputValue();
  await start.hover();
  await page.mouse.wheel(0, -300);
  await page.mouse.wheel(0, 300);
  expect(await start.inputValue()).toBe(shown);
  expect(Math.round(((await regions(page))[0]!.start - s0) * 1000)).toBe(-1);
  // the field has a stable id and a visible focus state
  expect(await start.getAttribute('id')).toMatch(/^loop-.+-start$/);
  const outline = await start.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('Add loop opens a loop at the playhead: 4 bars, or 8 s without a beat', async ({ page }) => {
  const { a } = await setup(page);
  await seek(page, a.start);
  await page.getByTestId('add-loop').click();
  const [r] = await regions(page);
  const barSeconds = await appState<number>(page, 's.grid.barSeconds');
  expect(r!.end - r!.start).toBeCloseTo(4 * barSeconds, 1);
});
