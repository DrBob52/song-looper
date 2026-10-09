import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SKINS } from '../../src/ui/skins';
import type { SkinId } from '../../src/ui/skins';
import { auditLoopDialog, auditPage, auditWholeSong, loadBusyPage, settle } from './overlap';
import { fontsDir, loadedFamilies, useRealFonts } from './realFonts';

// The overlap guard again, with the real fonts instead of the fallbacks: the layout is only known to be right if it is
// right with the fonts the designs were made for, which are wider or narrower than their fallbacks. It needs the fonts
// on disk (see realFonts.ts: npx tsx scripts/mirror-fonts.ts <folder>, then FONTS_DIR=<folder>), so it is skipped
// where there are none; the same checks run against the fallbacks in layout-overlap.spec.ts and skins-fonts.spec.ts.
test.skip(!fontsDir(), 'set FONTS_DIR to a folder made by scripts/mirror-fonts.ts to run the layout guard with the real fonts');

/** The families each look draws its text in, as Google Fonts names them. */
const FAMILIES: Record<SkinId, string[]> = {
  vinyl: ['Archivo', 'IBM Plex Mono'],
  studio: ['IBM Plex Sans Condensed', 'IBM Plex Mono', 'VT323'],
  club: ['Unbounded', 'Manrope', 'JetBrains Mono'],
  pro: ['Geist', 'Geist Mono'],
  space: ['Michroma', 'Exo 2', 'Share Tech Mono'],
};

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
  test(`${skin.id}: with its real fonts loaded, the page has no overlaps from 320 to 2560 px, light and dark`, async ({ browser }) => {
    const problems: string[] = [];
    for (const mode of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, colorScheme: mode });
      await useRealFonts(context);
      const page = await context.newPage();
      await chooseSkin(page, skin.id);
      await loadBusyPage(page, { selection: true });
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin.id);
      await settle(page);
      const families = await loadedFamilies(page);
      for (const family of FAMILIES[skin.id]) expect(families, `${skin.id} ${mode}: ${family} loaded`).toContain(family);
      for (const width of [1100, 380, 1600, 320, 768, 2560]) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditPage(page, `${skin.id} ${mode} ${width}px, real fonts`)));
      }
      // and Export loop's dialog (SPEC-v1.3.md 7.1)
      for (const width of [320, 380, 1100]) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        problems.push(...(await auditLoopDialog(page, `${skin.id} ${mode} ${width}px, real fonts, Export loop dialog`)));
      }
      // and Loop the whole song (SPEC-v1.4.md 3)
      problems.push(...(await auditWholeSong(page, `${skin.id} ${mode}, real fonts`, [320, 768, 2560])));
      await context.close();
    }
    expect(problems).toEqual([]);
  });
}
