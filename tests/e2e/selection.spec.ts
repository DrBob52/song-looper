import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { formatClock } from '../../src/util/time';
import { appState, dragSelect, loadFixture, makeFixture, waitForAnalysis } from './helpers';

// SPEC-v1.3.md 7.2: the selection bar under the waveform, typed selection times, and the timestamps at the selection's edges.

interface Sel {
  start: number;
  end: number;
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const selection = (page: Page): Promise<Sel | null> => appState<Sel | null>(page, 's.selection');

async function setUp(page: Page): Promise<{ duration: number }> {
  const fixture = await makeFixture({ structure: 'ABABCA', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  return { duration: fixture.duration };
}

/** The visible timestamps at the selection's edges (they live inside the waveform's shadow tree). */
async function labels(page: Page): Promise<{ edge: string; text: string; box: Box }[]> {
  const found = page.locator('[data-testid=selection-label]:visible');
  const out: { edge: string; text: string; box: Box }[] = [];
  for (let i = 0; i < (await found.count()); i++) {
    const el = found.nth(i);
    out.push({ edge: (await el.getAttribute('data-edge'))!, text: (await el.textContent())!, box: (await el.boundingBox())! });
  }
  return out;
}

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;

/** The labels never overlap each other and stay on the waveform. */
async function expectLabelsClear(page: Page, what: string): Promise<void> {
  const wave = (await page.getByTestId('waveform').boundingBox())!;
  const ls = await labels(page);
  for (const l of ls) {
    expect(l.box.x, `${what}: ${l.edge} label inside the waveform (left)`).toBeGreaterThanOrEqual(wave.x - 0.5);
    expect(right(l.box), `${what}: ${l.edge} label inside the waveform (right)`).toBeLessThanOrEqual(right(wave) + 0.5);
    expect(l.box.y).toBeGreaterThanOrEqual(wave.y - 0.5);
    expect(bottom(l.box)).toBeLessThanOrEqual(bottom(wave) + 0.5);
  }
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i]!.box;
      const b = ls[j]!.box;
      const ox = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
      const oy = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
      expect(ox > 0 && oy > 0, `${what}: ${ls[i]!.edge} and ${ls[j]!.edge} labels overlap`).toBe(false);
    }
  }
}

/** The selection region on the waveform. */
const region = (page: Page): Promise<Box> => page.locator('[data-region-id=selection]').boundingBox().then((b) => b!);

test('dragging a selection shows the bar right under the waveform with its times, length and buttons; nothing selected, no bar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setUp(page);
  const bar = page.getByTestId('selection-bar');
  await expect(bar).toBeHidden();
  await expect(page.locator('[data-testid=selection-label]:visible')).toHaveCount(0);

  await dragSelect(page, 0.2, 0.55);
  await expect(bar).toBeVisible();
  const sel = (await selection(page))!;
  expect(sel.end - sel.start).toBeGreaterThan(10);
  await expect(page.getByTestId('selection-start')).toHaveValue(formatClock(sel.start));
  await expect(page.getByTestId('selection-end')).toHaveValue(formatClock(sel.end));
  // the length: seconds and bars (the selection snapped to bar lines)
  const barSeconds = await appState<number>(page, 's.grid.barSeconds');
  const bars = Math.round(((sel.end - sel.start) / barSeconds) * 10) / 10;
  await expect(page.getByTestId('selection-length')).toHaveText(`${(sel.end - sel.start).toFixed(3)} s · ${bars} bars`);
  for (const id of ['selection-add-loop', 'selection-cut', 'selection-clear']) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('selection-add-loop')).toHaveText('Add as loop');
  await expect(page.getByTestId('selection-cut')).toContainText('Cut');
  await expect(page.getByTestId('selection-clear')).toHaveText('Clear');

  // directly under the waveform, inside its card, above the loops
  const wave = (await page.getByTestId('waveform').boundingBox())!;
  const b = (await bar.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(bottom(wave) - 0.5);
  expect(b.y - bottom(wave)).toBeLessThan(24);
  const loops = (await page.getByTestId('regions').boundingBox())!;
  expect(b.y + b.height).toBeLessThan(loops.y);

  // the timestamps at the two edges: the start label left of the region, the end label right of it
  const ls = await labels(page);
  expect(ls.map((l) => l.edge).sort()).toEqual(['end', 'start']);
  const r = await region(page);
  const start = ls.find((l) => l.edge === 'start')!;
  const end = ls.find((l) => l.edge === 'end')!;
  expect(start.text).toBe(formatClock(sel.start));
  expect(end.text).toBe(formatClock(sel.end));
  expect(right(start.box)).toBeLessThanOrEqual(r.x + 1);
  expect(end.box.x).toBeGreaterThanOrEqual(right(r) - 1);
  await expectLabelsClear(page, 'wide selection');

  // Clear takes the bar, the region and the labels away; so does Escape
  await page.getByTestId('selection-clear').click();
  await expect(bar).toBeHidden();
  expect(await selection(page)).toBeNull();
  await expect(page.locator('[data-region-id=selection]')).toHaveCount(0);
  await expect(page.locator('[data-testid=selection-label]:visible')).toHaveCount(0);
  await dragSelect(page, 0.3, 0.5);
  await expect(bar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  expect(errors).toEqual([]);
});

test('the bar and the timestamps follow a selection while it is being dragged', async ({ page }) => {
  await setUp(page);
  const box = (await page.getByTestId('waveform').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.3 + 0.04 * i), y);
  // the mouse is still down: the fields already show the span being dragged out
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  const startText = await page.getByTestId('selection-start').inputValue();
  const endText = await page.getByTestId('selection-end').inputValue();
  expect(startText).not.toBe(endText);
  const labelsNow = await labels(page);
  expect(labelsNow.find((l) => l.edge === 'end')?.text).toBe(endText);
  await page.mouse.move(box.x + box.width * 0.8, y);
  await expect(page.getByTestId('selection-end')).not.toHaveValue(endText);
  await page.mouse.up();
  const sel = (await selection(page))!;
  await expect(page.getByTestId('selection-start')).toHaveValue(formatClock(sel.start));
  await expect(page.getByTestId('selection-end')).toHaveValue(formatClock(sel.end));
});

test('typing a time moves the selection at once, to the millisecond and never snapped; Escape puts the old time back; bad times are refused', async ({ page }) => {
  const { duration } = await setUp(page);
  await dragSelect(page, 0.2, 0.55);
  const wave = (await page.getByTestId('waveform').boundingBox())!;
  const startField = page.getByTestId('selection-start');
  const endField = page.getByTestId('selection-end');

  // the end first, then the start: exact values, not on a bar line
  await endField.fill('0:31.337');
  await endField.press('Enter');
  expect(await appState<number>(page, 's.selection.end')).toBe(31.337);
  await startField.fill('12.345');
  await startField.press('Enter');
  expect(await appState<number>(page, 's.selection.start')).toBe(12.345);
  await expect(startField).toHaveValue('0:12.345');
  // the region on the waveform moved there (within a pixel or two)
  const bars = await appState<number[]>(page, 's.grid.bars');
  expect(bars.some((t) => Math.abs(t - 12.345) < 0.001)).toBe(false);
  const r = await region(page);
  expect(Math.abs(r.x - (wave.x + (12.345 / duration) * wave.width))).toBeLessThan(2.5);
  expect(Math.abs(right(r) - (wave.x + (31.337 / duration) * wave.width))).toBeLessThan(2.5);
  // the timestamps and the length follow
  const ls = await labels(page);
  expect(ls.find((l) => l.edge === 'start')?.text).toBe('0:12.345');
  expect(ls.find((l) => l.edge === 'end')?.text).toBe('0:31.337');
  await expect(page.getByTestId('selection-length')).toContainText('18.992 s');
  await expectLabelsClear(page, 'typed');

  // the arrow keys step by 10 ms
  await startField.focus();
  await startField.press('ArrowUp');
  expect(await appState<number>(page, 's.selection.start')).toBe(12.355);
  await startField.press('ArrowDown');
  await startField.press('ArrowDown');
  expect(await appState<number>(page, 's.selection.start')).toBe(12.335);

  // Escape puts the old value back and leaves the selection alone
  await startField.fill('0:20.000');
  await startField.press('Escape');
  await expect(startField).toHaveValue('0:12.335');
  expect(await appState<number>(page, 's.selection.start')).toBe(12.335);

  // bad times, in the loop fields' words; the selection keeps its times
  await startField.fill('soon');
  await startField.press('Enter');
  await expect(startField).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#selection-start-msg')).toHaveText('Enter a time like 1:09.600, 1:09 or 69.6.');
  await startField.fill('0:40.000');
  await startField.press('Enter');
  await expect(page.locator('#selection-start-msg')).toHaveText('Start must be before end (0:31.337).');
  await endField.fill('0:05.000');
  await endField.press('Enter');
  await expect(page.locator('#selection-end-msg')).toHaveText('End must be after start (0:12.335).');
  await endField.fill('99:00');
  await endField.press('Enter');
  await expect(page.locator('#selection-end-msg')).toHaveText(`Past the end of the song (${formatClock(duration)}).`);
  expect(await selection(page)).toEqual({ start: 12.335, end: 31.337 });
  // and a good value clears the message
  await endField.fill('0:33');
  await endField.press('Enter');
  await expect(endField).not.toHaveAttribute('aria-invalid', 'true');
  expect(await appState<number>(page, 's.selection.end')).toBe(33);
});

test('Add as loop and Cut use the typed times exactly, as do L and X', async ({ page }) => {
  await setUp(page);
  const typed = async (a: string, b: string): Promise<void> => {
    await dragSelect(page, 0.55, 0.7);
    await page.getByTestId('selection-end').fill(b);
    await page.getByTestId('selection-end').press('Enter');
    await page.getByTestId('selection-start').fill(a);
    await page.getByTestId('selection-start').press('Enter');
  };
  // a loop from the button
  await dragSelect(page, 0.2, 0.3);
  await page.getByTestId('selection-end').fill('0:20.678');
  await page.getByTestId('selection-end').press('Enter');
  await page.getByTestId('selection-start').fill('0:12.345');
  await page.getByTestId('selection-start').press('Enter');
  await page.getByTestId('selection-add-loop').click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  const [loop] = await appState<{ start: number; end: number }[]>(page, 's.regions');
  expect(loop).toMatchObject({ start: 12.345, end: 20.678 });
  await expect(page.getByTestId('loop-start').first()).toHaveValue('0:12.345');
  await expect(page.getByTestId('loop-end').first()).toHaveValue('0:20.678');
  await expect(page.getByTestId('selection-bar')).toBeHidden();

  // a cut from the button
  await typed('0:30.250', '0:35.500');
  await page.getByTestId('selection-cut').click();
  await expect(page.getByTestId('cut')).toHaveCount(1);
  expect(await appState<{ start: number; end: number }[]>(page, 's.cuts')).toMatchObject([{ start: 30.25, end: 35.5 }]);
  await expect(page.getByTestId('selection-bar')).toBeHidden();

  // the keys do the same with the typed times (the focus leaves the field first)
  await typed('0:38.111', '0:41.222');
  await page.getByTestId('wave-hint').click();
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(2);
  expect((await appState<{ start: number; end: number }[]>(page, 's.regions'))[1]).toMatchObject({ start: 38.111, end: 41.222 });
  await typed('0:43.001', '0:45.999');
  await page.getByTestId('wave-hint').click();
  await page.keyboard.press('x');
  await expect(page.getByTestId('cut')).toHaveCount(2);
  expect((await appState<{ start: number; end: number }[]>(page, 's.cuts'))[1]).toMatchObject({ start: 43.001, end: 45.999 });

  // a typed span over a loop or a cut is allowed to sit there; Cut refuses it, naming what it hits, and keeps the selection
  await dragSelect(page, 0.2, 0.3);
  await page.getByTestId('selection-start').fill('0:10.000');
  await page.getByTestId('selection-start').press('Enter');
  await page.getByTestId('selection-end').fill('0:14.000');
  await page.getByTestId('selection-end').press('Enter');
  expect(await selection(page)).toEqual({ start: 10, end: 14 });
  await page.getByTestId('selection-cut').click();
  await expect(page.getByTestId('notice')).toContainText('Overlaps Loop 1 (0:12.345–0:20.678)');
  expect(await selection(page)).toEqual({ start: 10, end: 14 });
  await expect(page.getByTestId('cut')).toHaveCount(2);
});

test('I and O set the selection from the playhead, and the fields and timestamps follow', async ({ page }) => {
  await setUp(page);
  const box = (await page.getByTestId('waveform').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width * 0.25, y);
  await page.keyboard.press('i');
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  const first = (await selection(page))!;
  await expect(page.getByTestId('selection-start')).toHaveValue(formatClock(first.start));
  await page.mouse.click(box.x + box.width * 0.5, y);
  await page.keyboard.press('o');
  const sel = (await selection(page))!;
  expect(sel.start).toBeCloseTo(first.start, 6);
  expect(sel.end).toBeGreaterThan(sel.start + 5);
  await expect(page.getByTestId('selection-end')).toHaveValue(formatClock(sel.end));
  await expect(page.getByTestId('selection-start')).toHaveValue(formatClock(sel.start));
  const ls = await labels(page);
  expect(ls.find((l) => l.edge === 'start')?.text).toBe(formatClock(sel.start));
  expect(ls.find((l) => l.edge === 'end')?.text).toBe(formatClock(sel.end));
  // with a loop selected, I and O belong to the loop and the selection is left alone
  await page.getByTestId('selection-add-loop').click();
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await expect(page.getByTestId('selection-bar')).toBeHidden();
});

test('the timestamps never overlap or leave the waveform: flipped inside at the song\'s edges, one combined label when narrow', async ({ page }) => {
  const { duration } = await setUp(page);
  const startField = page.getByTestId('selection-start');
  const endField = page.getByTestId('selection-end');

  // a narrow selection: one combined label m:ss.mmm–m:ss.mmm
  await dragSelect(page, 0.3, 0.31);
  const narrow = (await selection(page))!;
  let ls = await labels(page);
  expect(ls).toHaveLength(1);
  expect(ls[0]!.edge).toBe('both');
  expect(ls[0]!.text).toBe(`${formatClock(narrow.start)}–${formatClock(narrow.end)}`);
  await expectLabelsClear(page, 'narrow');
  // the same by typing: 80 ms is a hair of the waveform
  await endField.fill('0:20.080');
  await endField.press('Enter');
  await startField.fill('0:20.000');
  await startField.press('Enter');
  ls = await labels(page);
  expect(ls).toHaveLength(1);
  expect(ls[0]!.text).toBe('0:20.000–0:20.080');
  await expectLabelsClear(page, 'typed narrow');

  // at the start of the song: the start label flips inside
  await endField.fill('0:15.000');
  await endField.press('Enter');
  await startField.fill('0:00.000');
  await startField.press('Enter');
  ls = await labels(page);
  expect(ls.map((l) => l.edge).sort()).toEqual(['end', 'start']);
  await expectLabelsClear(page, 'at the start');
  const r0 = await region(page);
  expect(ls.find((l) => l.edge === 'start')!.box.x).toBeGreaterThanOrEqual(r0.x - 0.5);

  // at the end of the song: the end label flips inside
  await endField.fill(formatClock(duration));
  await endField.press('Enter');
  await startField.fill('0:30.000');
  await startField.press('Enter');
  ls = await labels(page);
  expect(ls.map((l) => l.edge).sort()).toEqual(['end', 'start']);
  await expectLabelsClear(page, 'at the end');
  const r1 = await region(page);
  expect(right(ls.find((l) => l.edge === 'end')!.box)).toBeLessThanOrEqual(right(r1) + 0.5);

  // the whole song selected: both flip inside
  await startField.fill('0:00.000');
  await startField.press('Enter');
  ls = await labels(page);
  expect(ls.map((l) => l.edge).sort()).toEqual(['end', 'start']);
  await expectLabelsClear(page, 'the whole song');

  // zoomed in, the labels stay with their edges
  await page.getByTestId('zoom-input').fill('200');
  await page.getByTestId('zoom-input').press('Enter');
  await endField.fill('0:15.000');
  await endField.press('Enter');
  await startField.fill('0:05.000');
  await startField.press('Enter');
  ls = await labels(page);
  expect(ls.length).toBeGreaterThan(0);
  const r2 = await region(page);
  for (const l of ls) {
    // inside the (scrolled) waveform view or not, a label sits beside its edge, in a band around the region
    expect(l.box.x).toBeGreaterThanOrEqual(r2.x - l.box.width - 8);
    expect(right(l.box)).toBeLessThanOrEqual(right(r2) + l.box.width + 8);
  }
});

test('the selection bar fits a phone: no overlap, no horizontal scroll, buttons reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await setUp(page);
  await dragSelect(page, 0.2, 0.6);
  const bar = page.getByTestId('selection-bar');
  await expect(bar).toBeVisible();
  const b = (await bar.boundingBox())!;
  const card = (await page.locator('section[aria-label=Waveform]').boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(card.x);
  expect(right(b)).toBeLessThanOrEqual(right(card) + 0.5);
  for (const id of ['selection-start', 'selection-end', 'selection-add-loop', 'selection-cut', 'selection-clear', 'selection-length']) {
    const e = (await page.getByTestId(id).boundingBox())!;
    expect(e.x, id).toBeGreaterThanOrEqual(b.x - 0.5);
    expect(right(e), id).toBeLessThanOrEqual(right(b) + 0.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectLabelsClear(page, '320 px');
});

test('a new song starts with no selection and no bar', async ({ page }) => {
  await setUp(page);
  await dragSelect(page, 0.2, 0.5);
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  await page.setInputFiles('[data-testid=file-input]', {
    name: 'other.wav',
    mimeType: 'audio/wav',
    buffer: (await makeFixture({ structure: 'AB', barsPerSection: 4 }, 'other.wav')).buffer,
  });
  await expect(page.getByTestId('selection-bar')).toBeHidden();
  expect(await selection(page)).toBeNull();
});
