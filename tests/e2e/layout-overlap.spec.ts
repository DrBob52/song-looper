import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { auditPage, loadBusyPage, settle } from './overlap';

// SPEC-v1.3.md section 1: nothing overlaps, nothing sticks out of its card, the turntable bar is hidden until a song is
// in and never covers a card at the bottom of the page. The guard itself is in overlap.ts.

const WIDTHS = [380, 1100, 1600] as const;

interface Look {
  skin: string;
  modes: readonly ('light' | 'dark')[];
}
// the skins arrive with SPEC-v1.3.md section 5; each one is added here as it lands
// (Studio and Club are dark whatever the host says: they are checked on a light host and on a dark one)
const LOOKS: Look[] = [
  { skin: 'vinyl', modes: ['light', 'dark'] },
  { skin: 'studio', modes: ['light', 'dark'] },
  { skin: 'club', modes: ['light', 'dark'] },
  { skin: 'pro', modes: ['light', 'dark'] },
  { skin: 'space', modes: ['light', 'dark'] },
];

/** Choose a skin before the page loads (a no-op for the default). */
async function chooseSkin(page: Page, skin: string): Promise<void> {
  if (skin === 'vinyl') return;
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('song-looper-skin', s);
    } catch {
      /* private window */
    }
  }, skin);
}

for (const look of LOOKS) {
  test(`${look.skin}: the empty page has no overlaps at 380, 1100 and 1600 px, and no turntable bar`, async ({ browser }) => {
    const problems: string[] = [];
    for (const mode of look.modes) {
      for (const width of [...WIDTHS, 768]) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: mode });
        const page = await context.newPage();
        await chooseSkin(page, look.skin);
        await page.goto('/');
        await expect(page.getByTestId('dropzone')).toBeVisible();
        // no player bar before a song is in
        await expect(page.locator('.transport')).toBeHidden();
        await expect(page.getByTestId('play')).toBeHidden();
        problems.push(...(await auditPage(page, `${look.skin} ${mode} ${width}px empty`)));
        await context.close();
      }
    }
    expect(problems).toEqual([]);
  });

  test(`${look.skin}: the loaded page (two loops) has no overlaps at 380, 1100 and 1600 px, and the bar never covers a card`, async ({ browser }) => {
    const problems: string[] = [];
    for (const mode of look.modes) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, colorScheme: mode });
      const page = await context.newPage();
      await chooseSkin(page, look.skin);
      await loadBusyPage(page);
      await expect(page.locator('.transport')).toBeVisible();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditPage(page, `${look.skin} ${mode} ${width}px loaded`)));
      }
      // the other states of the same cards: a message under a field, the advanced and speed panels open, target mode
      await page.getByTestId('loop-start').first().fill('soon');
      await page.getByTestId('loop-start').first().press('Enter');
      await expect(page.getByTestId('loop-start').first()).toHaveAttribute('aria-invalid', 'true');
      await page.getByTestId('end-at-input').fill('9:00.000');
      await page.getByTestId('end-at-input').press('Enter');
      await expect(page.getByTestId('end-at-input')).toHaveAttribute('aria-invalid', 'true');
      await page.getByTestId('cut-end').first().fill('soon');
      await page.getByTestId('cut-end').first().press('Enter');
      await expect(page.getByTestId('cut-end').first()).toHaveAttribute('aria-invalid', 'true');
      await page.locator('summary', { hasText: 'Advanced' }).click();
      await page.getByTestId('length-mode-target').check();
      const speed = page.locator('summary', { hasText: 'Speed & pitch' });
      if (!(await page.getByTestId('speed-input').isVisible())) await speed.click();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditPage(page, `${look.skin} ${mode} ${width}px loaded, panels open`)));
      }
      // Suggested loops collapsed to its header (SPEC-v1.3.md 7.3): the toggle and the cards around it still clear each other
      await page.getByTestId('suggestions-toggle').click();
      await expect(page.getByTestId('suggestions-toggle')).toHaveAttribute('aria-expanded', 'false');
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditPage(page, `${look.skin} ${mode} ${width}px loaded, suggestions collapsed`)));
      }
      // a span selected on the waveform (SPEC-v1.3.md 7.2): the selection bar under it, and the timestamps at its edges
      // (two when the selection is wide, one combined label when it is narrow)
      await page.getByTestId('suggestions-toggle').click();
      for (const [name, span] of [
        ['wide', { start: 20.2, end: 31.7 }],
        ['narrow', { start: 52.1, end: 52.9 }],
      ] as const) {
        await page.evaluate((sel) => (window as unknown as { songLooper: { store: { set(p: object): void } } }).songLooper.store.set({ selection: sel }), span);
        await expect(page.getByTestId('selection-bar')).toBeVisible();
        await expect(page.locator('[data-testid=selection-label]:visible')).toHaveCount(name === 'wide' ? 2 : 1);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          await settle(page);
          problems.push(...(await auditPage(page, `${look.skin} ${mode} ${width}px loaded, ${name} selection`)));
        }
      }
      await context.close();
    }
    expect(problems).toEqual([]);
  });
}

test('the turntable bar slides in when a song is decoded, and is not animated with reduced motion', async ({ browser }) => {
  const calm = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  const still = await calm.newPage();
  await loadBusyPage(still);
  await expect(still.locator('.transport')).toBeVisible();
  expect(await still.locator('.transport').evaluate((el) => el.getAnimations().length)).toBe(0);
  await calm.close();

  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.transport')).toBeHidden();
  expect(await page.locator('.transport').evaluate((el) => (el as HTMLElement).hidden)).toBe(true);
  // the animation is 200 ms long and runs once, as the bar appears
  const anim = await page.evaluate(async () => {
    const bar = document.querySelector('.transport') as HTMLElement;
    bar.hidden = false;
    await new Promise((r) => requestAnimationFrame(r));
    const a = bar.getAnimations()[0];
    const out = a ? { name: (a as CSSAnimation).animationName, duration: a.effect!.getComputedTiming().duration } : null;
    bar.hidden = true;
    return out;
  });
  expect(anim).toEqual({ name: 'bar-in', duration: 200 });
  await context.close();
});

test('the page keeps bottom padding equal to the turntable bar height while the bar is shown', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  await page.goto('/');
  expect(await page.locator('.app').evaluate((el) => el.style.getPropertyValue('--bar-h'))).toBe('0px');
  await loadBusyPage(page);
  await settle(page);
  const m = await page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement;
    const bar = document.querySelector('.transport') as HTMLElement;
    return { barHeight: bar.getBoundingClientRect().height, bar: parseFloat(app.style.getPropertyValue('--bar-h')), padding: parseFloat(getComputedStyle(app).paddingBottom) };
  });
  expect(Math.abs(m.bar - m.barHeight)).toBeLessThanOrEqual(1);
  expect(m.padding).toBeGreaterThanOrEqual(m.barHeight + 24 - 1);
  // opening the speed and pitch panel makes the bar taller; the padding follows
  const before = m.barHeight;
  await page.locator('summary', { hasText: 'Speed & pitch' }).click();
  await settle(page);
  const after = await page.evaluate(() => ({
    barHeight: (document.querySelector('.transport') as HTMLElement).getBoundingClientRect().height,
    bar: parseFloat((document.querySelector('.app') as HTMLElement).style.getPropertyValue('--bar-h')),
  }));
  expect(Math.abs(after.barHeight - before)).toBeGreaterThan(20);
  expect(Math.abs(after.bar - after.barHeight)).toBeLessThanOrEqual(1);
  await context.close();
});
