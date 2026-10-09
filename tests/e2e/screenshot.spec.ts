import { mkdirSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SKINS } from '../../src/ui/skins';
import { appState, loadFixture, makeChordFixture, waitForAnalysis } from './helpers';
import { loadBusyPage, settle } from './overlap';
import { fontsDir, loadedFamilies, useRealFonts } from './realFonts';

// Regenerates the README pictures: SCREENSHOT=1 npx playwright test screenshot
//   docs/whole-song.png and docs/whole-song-phone-dark.png: the Loop the whole song panel (SPEC-v1.4.md);
//   docs/screenshot.png (light) and docs/screenshot-dark.png: desktop; docs/screenshot-phone.png and
//   docs/screenshot-phone-dark.png: 380 px wide; docs/themes/<skin>-<mode>-<wide|phone>.png: every look in every mode
//   it has (Studio hardware and Night club are dark whatever the host says, so they have a dark picture only).
// The pictures should show the real fonts. If the browser can't reach Google Fonts (a sandbox with an intercepting
// proxy, say), mirror them once and point FONTS_DIR at the folder (see realFonts.ts):
//   npx tsx scripts/mirror-fonts.ts $FONTS_DIR
//   FONTS_DIR=$FONTS_DIR SCREENSHOT=1 npx playwright test screenshot
// Each picture is taken only once the look's fonts have loaded (when FONTS_DIR is set), and the faces that were used are
// printed next to its file name.
test.skip(!process.env.SCREENSHOT, 'set SCREENSHOT=1 to regenerate the screenshots in docs/');

const WIDE = 1280;
const PHONE = 380;

async function choose(page: Page, skin: string): Promise<void> {
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('song-looper-skin', s);
    } catch {
      /* private window */
    }
  }, skin);
}

/** A loaded song with its suggestions, two loops (one with a bridge, one rough with a cleaner loop suggested), a cut, an end point with a fade, and a span selected on the waveform. */
async function setUp(page: Page, skin: string): Promise<string[]> {
  await choose(page, skin);
  await loadBusyPage(page);
  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('seam-summary').nth(1)).toBeVisible();
  // a span selected on the waveform, so that the selection bar and the timestamps at its edges are in every picture
  await page.evaluate(() => (window as unknown as { songLooper: { store: { set(p: object): void } } }).songLooper.store.set({ selection: { start: 46.4, end: 57.2 } }));
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  await page.mouse.move(2, 2); // no row left hovered
  await settle(page);
  await page.waitForTimeout(500);
  // the look's fonts: asked for when it was chosen, so wait for them to arrive and be applied
  const families = fontsDir() ? await loadedFamilies(page) : [];
  if (fontsDir()) {
    const wanted = SKINS.find((s) => s.id === skin)!;
    expect(families.length, `${wanted.id}: the real fonts were loaded`).toBeGreaterThan(0);
  }
  return families;
}

/**
 * The whole page at this width, with the turntable bar at the bottom of the picture: the window is grown to the height of
 * the page, so the sticky bar sits in its place after the last card, and the picture stops just under the bar (the page's
 * bottom padding, which keeps the bar clear of the last card on a real screen, is left out).
 */
async function shootWide(page: Page, width: number, path: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width, height: height + 24 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  const bottom = await page.evaluate(() => Math.ceil(document.querySelector('.transport')!.getBoundingClientRect().bottom));
  await page.screenshot({ path, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.min(height + 24, bottom + 18) } });
}

for (const scheme of ['light', 'dark'] as const) {
  const suffix = scheme === 'light' ? '' : '-dark';

  test(`take the ${scheme} desktop screenshot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
    await useRealFonts(context);
    const page = await context.newPage();
    const families = await setUp(page, 'vinyl');
    mkdirSync('docs', { recursive: true });
    await shootWide(page, 1100, `docs/screenshot${suffix}.png`);
    console.warn(`docs/screenshot${suffix}.png: fonts ${families.join(', ') || 'fallbacks'}`);
    await context.close();
  });

  test(`take the ${scheme} phone screenshot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: PHONE, height: 760 }, colorScheme: scheme, deviceScaleFactor: 2 });
    await useRealFonts(context);
    const page = await context.newPage();
    const families = await setUp(page, 'vinyl');
    mkdirSync('docs', { recursive: true });
    // the first loop card and the turntable bar
    await page.locator('.region').first().scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('.region')!.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -12));
    await settle(page);
    await page.screenshot({ path: `docs/screenshot-phone${suffix}.png`, animations: 'disabled' });
    console.warn(`docs/screenshot-phone${suffix}.png: fonts ${families.join(', ') || 'fallbacks'}`);
    await context.close();
  });
}

// every look, in every mode it has, wide and on a phone (docs/themes/<skin>-<mode>-<wide|phone>.png)
for (const skin of SKINS) {
  for (const mode of skin.modes === 'dark' ? (['dark'] as const) : (['light', 'dark'] as const)) {
    test(`take the ${skin.id} ${mode} screenshots, wide and phone`, async ({ browser }) => {
      mkdirSync('docs/themes', { recursive: true });
      const wide = await browser.newContext({ viewport: { width: WIDE, height: 900 }, colorScheme: mode, deviceScaleFactor: 1 });
      await useRealFonts(wide);
      const widePage = await wide.newPage();
      const wideFonts = await setUp(widePage, skin.id);
      await shootWide(widePage, WIDE, `docs/themes/${skin.id}-${mode}-wide.png`);
      console.warn(`docs/themes/${skin.id}-${mode}-wide.png: fonts ${wideFonts.join(', ') || 'fallbacks'}`);
      await wide.close();

      // the top of the page: the masthead with its picker, the song, the waveform with its selection bar under it, and the
      // turntable bar (the window is tall enough for the bar to sit under the selection bar, not on it)
      const phone = await browser.newContext({ viewport: { width: PHONE, height: 1060 }, colorScheme: mode, deviceScaleFactor: 2 });
      await useRealFonts(phone);
      const phonePage = await phone.newPage();
      const phoneFonts = await setUp(phonePage, skin.id);
      await phonePage.evaluate(() => window.scrollTo(0, 0));
      await settle(phonePage);
      await phonePage.screenshot({ path: `docs/themes/${skin.id}-${mode}-phone.png`, animations: 'disabled' });
      console.warn(`docs/themes/${skin.id}-${mode}-phone.png: fonts ${phoneFonts.join(', ') || 'fallbacks'}`);
      await phone.close();
    });
  }
}

// Loop the whole song (SPEC-v1.4.md 3): the panel asking to replace two loops, on a song with an intro, a body and an outro
for (const [name, width, scheme] of [
  ['whole-song', 820, 'light'],
  ['whole-song-phone-dark', 380, 'dark'],
] as const) {
  test(`take the ${name} screenshot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: width < 500 ? 2 : 1 });
    await useRealFonts(context);
    const page = await context.newPage();
    const fixture = await makeChordFixture(
      {
        progressions: { I: 'E B C#m A E B C#m A', A: 'C G Am F', B: 'Dm Em F G', C: 'Am F C G', O: 'Ab Fm Db Eb' },
        structure: 'IABABCAO',
        timbre: { I: 'sine', O: 'square' },
        hats: { A: true, B: true, C: true },
      },
      'intro-body-outro.wav',
    );
    await loadFixture(page, fixture);
    await waitForAnalysis(page);
    const [top] = await appState<{ start: number }[]>(page, 's.analysis.wholeSong');
    for (const [a, b] of [[2, 10], [16, 24]] as const) {
      await page.evaluate(([x, y]) => (window as unknown as { songLooper: { addLoop(s: object): unknown } }).songLooper.addLoop({ start: x, end: y }), [top!.start + a, top!.start + b]);
    }
    await expect(page.locator('[data-testid=regions] li')).toHaveCount(2);
    await page.getByTestId('whole-song').click();
    await page.getByTestId('whole-song-option').first().getByTestId('whole-song-use').click();
    await expect(page.getByTestId('whole-song-confirm')).toBeVisible();
    // a picture of the card: the turntable bar floats over the page, so it is left out
    await page.addStyleTag({ content: '.transport { display: none !important; }' });
    await page.mouse.move(2, 2);
    await settle(page);
    await page.waitForTimeout(500);
    if (fontsDir()) expect((await loadedFamilies(page)).length, 'the real fonts were loaded').toBeGreaterThan(0);
    mkdirSync('docs', { recursive: true });
    await page.locator('section[aria-label="Loop regions"]').screenshot({ path: `docs/${name}.png`, animations: 'disabled' });
    await context.close();
  });
}
