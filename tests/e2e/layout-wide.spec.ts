import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { loadBusyPage, settle } from './overlap';

// SPEC-v1.3.md 4: two columns on a wide window (1100 px and up), one column below.

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const card = (page: Page, label: string): Promise<Box> =>
  page.evaluate((name) => {
    const el = document.querySelector(`section[aria-label="${name}"]`) as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
  }, label);

const LABELS = {
  wave: 'Waveform',
  suggestions: 'Suggested loops',
  loops: 'Loop regions',
  cuts: 'Cuts',
  ending: 'Ending',
  length: 'Length',
  timeline: 'Extended timeline',
};

async function setWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await settle(page);
}

test('at 1440 px the cards sit in two columns: Your loops, Cuts and Ending on the left, Suggestions and Length on the right', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadBusyPage(page);
  await settle(page);
  await expect(page.getByTestId('columns')).toBeVisible();
  // which card is in which column
  const inColumn = (testId: string): Promise<string[]> =>
    page.evaluate((id) => [...document.querySelector(`[data-testid=${id}]`)!.children].map((c) => c.getAttribute('aria-label') ?? ''), testId);
  expect(await inColumn('column-main')).toEqual([LABELS.loops, LABELS.cuts, LABELS.ending]);
  expect(await inColumn('column-side')).toEqual([LABELS.suggestions, LABELS.length]);
  // in the panel: the waveform, the columns, the extended timeline
  expect(await page.evaluate(() => [...document.querySelector('[data-testid=song-panel]')!.children].map((c) => c.getAttribute('aria-label') ?? c.getAttribute('data-testid')))).toEqual([
    LABELS.wave,
    'columns',
    LABELS.timeline,
  ]);

  const b = {
    wave: await card(page, LABELS.wave),
    suggestions: await card(page, LABELS.suggestions),
    loops: await card(page, LABELS.loops),
    cuts: await card(page, LABELS.cuts),
    ending: await card(page, LABELS.ending),
    length: await card(page, LABELS.length),
    timeline: await card(page, LABELS.timeline),
  };
  // the main column's cards are left of the side column's, with a gap, and never overlap them
  for (const m of [b.loops, b.cuts, b.ending]) {
    for (const s of [b.suggestions, b.length]) expect(m.x + m.width, 'main card right of side card left').toBeLessThan(s.x - 8);
  }
  // 3fr : 2fr
  const ratio = b.loops.width / b.suggestions.width;
  expect(ratio).toBeGreaterThan(1.35);
  expect(ratio).toBeLessThan(1.65);
  expect(b.suggestions.width).toBeGreaterThanOrEqual(320);
  // each column is a stack of cards, one under the other
  expect(b.cuts.y).toBeGreaterThan(b.loops.y + b.loops.height);
  expect(b.ending.y).toBeGreaterThan(b.cuts.y + b.cuts.height);
  expect(b.length.y).toBeGreaterThan(b.suggestions.y + b.suggestions.height);
  expect(b.loops.y).toBeCloseTo(b.suggestions.y, 0);
  // the waveform and the extended timeline are full width
  const right = (x: Box): number => x.x + x.width;
  expect(b.wave.x).toBeCloseTo(b.loops.x, 0);
  expect(right(b.wave)).toBeCloseTo(right(b.length), 0);
  expect(b.timeline.x).toBeCloseTo(b.wave.x, 0);
  expect(right(b.timeline)).toBeCloseTo(right(b.wave), 0);
  expect(b.timeline.y).toBeGreaterThan(Math.max(b.ending.y + b.ending.height, b.length.y + b.length.height));
  // cards keep their natural height: the columns are top-aligned and grow independently
  const align = await page.evaluate(() => {
    const cols = getComputedStyle(document.querySelector('[data-testid=columns]')!);
    const main = document.querySelector('[data-testid=column-main]') as HTMLElement;
    const side = document.querySelector('[data-testid=column-side]') as HTMLElement;
    return { items: cols.alignItems, template: cols.gridTemplateColumns, mainH: main.getBoundingClientRect().height, sideH: side.getBoundingClientRect().height };
  });
  expect(align.items).toBe('start');
  expect(Math.abs(align.mainH - align.sideH)).toBeGreaterThan(50); // they are not stretched to each other
  // Start and End side by side where the card is wide enough for two
  const start = (await page.getByTestId('loop-start').first().boundingBox())!;
  const end = (await page.getByTestId('loop-end').first().boundingBox())!;
  expect(Math.abs(start.y - end.y)).toBeLessThan(6);
  expect(end.x).toBeGreaterThan(start.x + start.width);
  const cutStart = (await page.getByTestId('cut-start').first().boundingBox())!;
  const cutEnd = (await page.getByTestId('cut-end').first().boundingBox())!;
  expect(Math.abs(cutStart.y - cutEnd.y)).toBeLessThan(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('at 1099 px it is one column again, in the single-column order; resizing across 1100 px loses nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadBusyPage(page);
  await settle(page);
  await expect(page.getByTestId('columns')).toBeVisible();
  // a half-typed edit and a selection survive the move of the cards
  const start = page.getByTestId('loop-start').first();
  const typed = await start.inputValue();
  await setWidth(page, 1099);
  await expect(page.getByTestId('columns')).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelector('[data-testid=song-panel]')!.children].map((c) => c.getAttribute('aria-label')))).toEqual([
    LABELS.wave,
    LABELS.suggestions,
    LABELS.loops,
    LABELS.cuts,
    LABELS.ending,
    LABELS.length,
    LABELS.timeline,
  ]);
  const boxes = [];
  for (const label of Object.values(LABELS)) boxes.push(await card(page, label));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i]!.y, `card ${i} under card ${i - 1}`).toBeGreaterThan(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
    expect(boxes[i]!.x).toBeCloseTo(boxes[0]!.x, 0);
    expect(boxes[i]!.width).toBeCloseTo(boxes[0]!.width, 0);
  }
  // the page is the narrow one: a container of at most 880 px, 16 px gutters
  const app = await page.evaluate(() => {
    const el = document.querySelector('.app') as HTMLElement;
    return { max: getComputedStyle(el).maxWidth, left: getComputedStyle(el).paddingLeft };
  });
  expect(app).toEqual({ max: '880px', left: '16px' });
  // Start and End are on two lines here
  const s1 = (await page.getByTestId('loop-start').first().boundingBox())!;
  const e1 = (await page.getByTestId('loop-end').first().boundingBox())!;
  expect(e1.y).toBeGreaterThan(s1.y + 20);
  // and back to two columns, with the same loops, fields and values
  await setWidth(page, 1100);
  await expect(page.getByTestId('columns')).toBeVisible();
  expect(await page.getByTestId('regions').locator('li').count()).toBe(2);
  expect(await page.getByTestId('loop-start').first().inputValue()).toBe(typed);
  const app2 = await page.evaluate(() => {
    const el = document.querySelector('.app') as HTMLElement;
    return { max: getComputedStyle(el).maxWidth, left: getComputedStyle(el).paddingLeft };
  });
  expect(app2).toEqual({ max: '1480px', left: '24px' });
});

test('the container widens to about 1480 px with 24 px gutters and stays centred on a very wide window', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1000 });
  await loadBusyPage(page);
  await settle(page);
  const m = await page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement;
    const r = app.getBoundingClientRect();
    const wave = document.querySelector('section[aria-label=Waveform]')!.getBoundingClientRect();
    return { width: r.width, left: r.left, waveWidth: wave.width, waveLeft: wave.left, padding: getComputedStyle(app).paddingLeft };
  });
  expect(m.width).toBeCloseTo(1480, 0);
  expect(m.left).toBeCloseTo((2560 - 1480) / 2, 0);
  expect(m.padding).toBe('24px');
  expect(m.waveWidth).toBeCloseTo(1480 - 48, 0);
  expect(m.waveLeft).toBeCloseTo((2560 - 1480) / 2 + 24, 0);
  // at 1600 px the fields of a loop are side by side too
  await setWidth(page, 1600);
  const s = (await page.getByTestId('loop-start').first().boundingBox())!;
  const e = (await page.getByTestId('loop-end').first().boundingBox())!;
  expect(Math.abs(s.y - e.y)).toBeLessThan(6);
});

test('no horizontal scroll from 320 to 2560 px, empty and loaded', async ({ page }) => {
  const widths = [320, 360, 480, 640, 768, 1000, 1099, 1100, 1280, 1440, 1920, 2560];
  const overflow = (): Promise<{ scroll: number; inner: number }> =>
    page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: document.documentElement.clientWidth }));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('dropzone')).toBeVisible();
  for (const w of widths) {
    await setWidth(page, w);
    const o = await overflow();
    expect(o.scroll, `empty page at ${w} px`).toBeLessThanOrEqual(o.inner);
  }
  await loadBusyPage(page);
  for (const w of widths) {
    await setWidth(page, w);
    const o = await overflow();
    expect(o.scroll, `loaded page at ${w} px`).toBeLessThanOrEqual(o.inner);
    // wide windows have two columns, narrow ones none
    await expect(page.getByTestId('columns')).toHaveCount(w >= 1100 ? 1 : 0);
  }
});
