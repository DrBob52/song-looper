import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SKINS } from '../../src/ui/skins';
import type { SkinId } from '../../src/ui/skins';
import { loadFixture, makeFixture, waitForAnalysis } from './helpers';

// SPEC-v1.3.md 5: skins. Every skin shares the markup and test ids; the picker in the masthead switches them.

/** The skins that exist so far; each milestone adds its own. */
const READY: SkinId[] = ['vinyl', 'pro'];

const skinOf = (page: Page): Promise<string | undefined> => page.evaluate(() => document.documentElement.dataset.skin);
/** A token's value as the page has it (the build shortens #ffffff to #fff: written out in full again for comparing). */
const tokenOf = (page: Page, name: string): Promise<string> =>
  page
    .evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(), name)
    .then((v) => v.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3'));

test('the picker lists the five looks, marks the current one, and Vinyl is the default', async ({ page }) => {
  await page.goto('/');
  const group = page.getByTestId('look-picker');
  await expect(group).toBeVisible();
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(group.getByText('Look', { exact: true })).toBeVisible();
  for (const s of SKINS) {
    const radio = page.getByTestId(`look-${s.id}`);
    await expect(radio).toHaveAttribute('type', 'radio');
    await expect(page.locator('label.look', { hasText: s.name })).toBeVisible();
  }
  expect(SKINS.map((s) => s.id)).toEqual(['vinyl', 'studio', 'club', 'pro', 'space']);
  await expect(page.getByTestId('look-vinyl')).toBeChecked();
  expect(await skinOf(page)).toBe('vinyl');
  // the picker sits in the masthead, to the right of the title
  const title = (await page.getByRole('heading', { name: 'Song Looper' }).boundingBox())!;
  const picker = (await group.boundingBox())!;
  expect(picker.x).toBeGreaterThan(title.x + title.width);
});

test('choosing a look sets data-skin, is remembered across a reload, and leaves no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  // (Vinyl last: it is the one that is checked already, so choosing it first would change nothing)
  for (const id of [...READY].reverse()) {
    await page.getByTestId(`look-${id}`).check();
    expect(await skinOf(page)).toBe(id);
    await expect(page.getByTestId(`look-${id}`)).toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem('song-looper-skin'))).toBe(id);
    await page.reload();
    expect(await skinOf(page)).toBe(id);
    await expect(page.getByTestId(`look-${id}`)).toBeChecked();
  }
  expect(errors).toEqual([]);
});

test('the keyboard works the picker: Tab into the group, the arrow keys choose', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('look-vinyl').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('look-studio')).toBeChecked();
  expect(await skinOf(page)).toBe('studio');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('look-pro')).toBeChecked();
  expect(await skinOf(page)).toBe('pro');
  await page.keyboard.press('ArrowLeft');
  expect(await skinOf(page)).toBe('club');
});

test('a junk or blocked stored choice falls back to Vinyl, and a choice still works without storage', async ({ browser }) => {
  const junk = await browser.newContext();
  let page = await junk.newPage();
  await page.addInitScript(() => localStorage.setItem('song-looper-skin', 'neon-disco'));
  await page.goto('/');
  expect(await skinOf(page)).toBe('vinyl');
  await junk.close();

  const blocked = await browser.newContext();
  page = await blocked.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const deny = (): never => {
      throw new DOMException('denied', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { get: deny });
  });
  await page.goto('/');
  expect(await skinOf(page)).toBe('vinyl');
  await page.getByTestId('look-pro').check();
  expect(await skinOf(page)).toBe('pro');
  expect(errors).toEqual([]);
  await blocked.close();
});

test('a look loads its Google Fonts stylesheet the first time it is chosen, and only from fonts.googleapis.com', async ({ page }) => {
  const sheets: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('fonts.googleapis.com')) sheets.push(r.url());
  });
  await page.goto('/');
  // the default look: only what index.html has always loaded
  expect(sheets).toEqual(['https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;600&display=swap']);
  await expect(page.locator('link[data-skin-fonts]')).toHaveCount(0);
  const pro = SKINS.find((s) => s.id === 'pro')!;
  await page.getByTestId('look-pro').check();
  await expect(page.locator('link[data-skin-fonts="pro"]')).toHaveCount(1);
  await expect.poll(() => sheets.includes(pro.fonts!)).toBe(true);
  // choosing it again, or going back and forth, adds nothing
  await page.getByTestId('look-vinyl').check();
  await page.getByTestId('look-pro').check();
  await expect(page.locator('link[data-skin-fonts]')).toHaveCount(1);
  expect(sheets.filter((u) => u === pro.fonts)).toHaveLength(1);
  // every skin's stylesheet is a Google Fonts css2 URL, with a display=swap, and nothing else is loaded from outside
  for (const s of SKINS) if (s.fonts) expect(s.fonts).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=.+&display=swap$/);
});

test('switching looks while a song plays does not stop it, and the waveform takes the new look\'s colours', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 4 });
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const wave = (): Promise<{ wave: string; progress: string; cursor: string }> =>
    page.evaluate(() => {
      const o = (window as unknown as { songLooper: { waveform: { instance: { options: { waveColor: string; progressColor: string; cursorColor: string } } } } }).songLooper.waveform.instance.options;
      return { wave: String(o.waveColor), progress: String(o.progressColor), cursor: o.cursorColor };
    });
  const vinyl = await wave();
  expect(vinyl).toEqual({ wave: '#1d1915', progress: '#1d1915', cursor: '#c6372c' });
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  const t0 = await page.evaluate(() => (window as unknown as { songLooper: { player: { getTime(): number } } }).songLooper.player.getTime());
  for (const id of READY) {
    await page.getByTestId(`look-${id}`).check();
    await expect(page.getByTestId('play')).toHaveText('Pause');
    await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as unknown as { songLooper: { player: { isPlaying(): boolean } } }).songLooper.player.isPlaying())).toBe(true);
  }
  await page.waitForTimeout(400);
  const t1 = await page.evaluate(() => (window as unknown as { songLooper: { player: { getTime(): number } } }).songLooper.player.getTime());
  expect(t1).toBeGreaterThan(t0);
  // the last of them is Pro: the wave is its ink, the played part its accent, the playhead its strong accent
  await expect.poll(wave).toEqual({ wave: '#16181d', progress: '#3d6df2', cursor: '#3965e8' });
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  expect(errors).toEqual([]);
});

test('Pro: the spec tokens in light and dark, a solid accent circle to play, pills for the seam stamps', async ({ browser }) => {
  const LIGHT = { '--bg': '#f5f6f8', '--panel': '#ffffff', '--ink': '#16181d', '--ink-soft': '#5d6472', '--rule': '#e2e5ea', '--accent': '#3d6df2' };
  const DARK = { '--bg': '#0f1115', '--panel': '#171a20', '--ink': '#e8ebf0', '--ink-soft': '#9aa3b2', '--rule': '#262b33', '--accent': '#7aa2ff' };
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('song-looper-skin', 'pro'));
  await page.goto('/');
  for (const [name, v] of Object.entries(LIGHT)) expect(await tokenOf(page, name), name).toBe(v);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 246, 248)');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  for (const [name, v] of Object.entries(DARK)) expect(await tokenOf(page, name), name).toBe(v);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 17, 21)');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  for (const [name, v] of Object.entries(LIGHT)) expect(await tokenOf(page, name), name).toBe(v);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await context.close();

  const dark = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'dark' });
  const d = await dark.newPage();
  await d.addInitScript(() => localStorage.setItem('song-looper-skin', 'pro'));
  await d.goto('/');
  for (const [name, v] of Object.entries(DARK)) expect(await tokenOf(d, name), name).toBe(v);
  await d.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  for (const [name, v] of Object.entries(LIGHT)) expect(await tokenOf(d, name), name).toBe(v);
  await dark.close();

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('song-looper-skin', 'pro'));
  await loadFixture(p, await makeFixture({ structure: 'AB', barsPerSection: 4 }));
  await waitForAnalysis(p);
  // the play button: same testid, label and aria-pressed; a 56 px solid accent circle
  const rec = await p.locator('[data-testid=play] .record').evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, bg: s.backgroundColor, radius: s.borderRadius };
  });
  expect(rec).toEqual({ w: 56, h: 56, bg: 'rgb(57, 101, 232)', radius: '50%' });
  await expect(p.getByTestId('play')).toHaveText('Play');
  await p.keyboard.press('Space');
  await expect(p.getByTestId('play')).toHaveText('Pause');
  await expect(p.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
  await p.keyboard.press('Space');
  await expect(p.getByTestId('play')).toHaveText('Play');
  // radii of 8 px, hairline borders, no shadow on a card
  const card = await p.locator('.card').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, shadow: s.boxShadow, border: s.borderTopWidth };
  });
  expect(card).toEqual({ radius: '8px', shadow: 'none', border: '1px' });
  // the seam stamp: a pill with a dot, its word still there
  await p.evaluate(() => (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: 2, end: 8 }));
  const chip = p.getByTestId('seam-chip').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/^(Clean|OK|Rough)$/i);
  const pill = await chip.evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, transform: s.transform, dot: getComputedStyle(el, '::before').content };
  });
  expect(pill.transform).toBe('none');
  expect(parseFloat(pill.radius)).toBeGreaterThan(10);
  expect(pill.dot).toBe('""');
  await ctx.close();
});
