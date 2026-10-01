import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SKINS } from '../../src/ui/skins';
import { auditLoopDialog, auditPage, loadBusyPage, settle } from './overlap';

// SPEC-v1.3.md 5.3, "Fonts blocked": every skin still renders with its fallback fonts when the Google Fonts hosts cannot
// be reached: no overlap, nothing sticking out, no horizontal scroll, no errors, and playback keeps working.

const GENERIC = /(^|,)\s*(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-monospace|ui-serif|cursive|fantasy)\s*$/;
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;

interface Watch {
  errors: string[];
  blocked: string[];
}

/** Abort every Google Fonts request and collect what is not a font request's own failure. */
async function blockFonts(page: Page): Promise<Watch> {
  const watch: Watch = { errors: [], blocked: [] };
  await page.route(FONT_HOST, (r) => {
    watch.blocked.push(r.request().url());
    return r.abort();
  });
  page.on('pageerror', (e) => watch.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // the browser logs "Failed to load resource" for the aborted font request itself; that is the point of the test
    if (m.type() === 'error' && !FONT_HOST.test(m.location().url)) watch.errors.push(`console: ${m.text()}`);
  });
  return watch;
}

async function chooseSkin(page: Page, skin: string): Promise<void> {
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('song-looper-skin', s);
    } catch {
      /* private window */
    }
  }, skin);
}

for (const skin of SKINS) {
  test(`${skin.id}: with Google Fonts blocked the fallbacks take over, nothing overlaps, and nothing logs an error`, async ({ browser }) => {
    const problems: string[] = [];
    for (const mode of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, colorScheme: mode });
      const page = await context.newPage();
      const watch = await blockFonts(page);
      await chooseSkin(page, skin.id);
      await loadBusyPage(page, { selection: true });
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin.id);

      // the stylesheet was asked for (Vinyl's is in index.html, the others' are added when the skin is used) and refused
      expect(watch.blocked.length, `${skin.id} asked for its fonts`).toBeGreaterThan(0);
      if (skin.fonts) expect(await page.locator(`link[data-skin-fonts="${skin.id}"]`).count()).toBe(1);
      const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
      expect(loaded).toBe(0);
      // every font stack the page uses ends in a generic family, so the fallback is a real font and not the browser default
      const stacks = await page.evaluate(() =>
        [document.body, document.querySelector('h1'), document.querySelector('[data-testid=loop-start]'), document.querySelector('[data-testid=play]')].map((el) =>
          el ? getComputedStyle(el).fontFamily : 'missing',
        ),
      );
      for (const stack of stacks) expect(stack, `${skin.id} ${mode} font stack`).toMatch(GENERIC);

      for (const width of [1100, 380, 1600, 320, 2560]) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditPage(page, `${skin.id} ${mode} ${width}px, fonts blocked`)));
      }
      // and Export loop's dialog (SPEC-v1.3.md 7.1)
      for (const width of [320, 1100]) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditLoopDialog(page, `${skin.id} ${mode} ${width}px, fonts blocked, Export loop dialog`)));
      }

      // and it still plays
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.getByTestId('play').click();
      await expect(page.getByTestId('play')).toHaveText('Pause');
      await page.getByTestId('play').click();
      expect(watch.errors).toEqual([]);
      await context.close();
    }
    expect(problems).toEqual([]);
  });
}

test('switching through every look with Google Fonts blocked keeps the song playing and logs no errors', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  const watch = await blockFonts(page);
  await loadBusyPage(page);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  for (const s of [...SKINS].reverse().concat(SKINS[1]!)) {
    await page.getByTestId(`look-${s.id}`).check();
    await expect(page.locator('html')).toHaveAttribute('data-skin', s.id);
    await expect(page.getByTestId('play')).toHaveText('Pause');
  }
  // one stylesheet per look that has one, however many times it was chosen
  expect(await page.locator('link[data-skin-fonts]').count()).toBe(SKINS.filter((s) => s.fonts).length);
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  expect(watch.errors).toEqual([]);
  await context.close();
});
