import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { appState, clickTrackFixture, loadFixture, makeChordFixture, waitForAnalysis } from './helpers';
import { SONG1 } from '../fixtures/synth';

// SPEC-v1.2.md Part 2: the vinyl and analog design.

const LIGHT = {
  '--paper': '#efe6d6',
  '--sleeve': '#f8f2e7',
  '--ink': '#1d1915',
  '--ink-soft': '#6b6157',
  '--rule': '#d8ccb8',
  '--label-red': '#c6372c',
  '--mustard': '#d6a03d',
  '--vinyl': '#121110',
  '--ok': '#2f7a4f',
  '--warn': '#b8741a',
  '--bad': '#b3261e',
  '--loop-1': '#c6372c',
  '--loop-2': '#2e5aa8',
  '--loop-3': '#d6a03d',
  '--loop-4': '#2f7f79',
  '--loop-5': '#7a3e6e',
};
const DARK = {
  '--paper': '#17130f',
  '--sleeve': '#221c16',
  '--ink': '#efe4d3',
  '--ink-soft': '#a8998a',
  '--rule': '#3a3027',
  '--label-red': '#e0574a',
  '--mustard': '#e3b25a',
  '--vinyl': '#0b0a09',
};

const tokens = (page: Page, names: string[]): Promise<Record<string, string>> =>
  page.evaluate(
    (list) => Object.fromEntries(list.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase()])),
    names,
  );

test('the tokens are the specified ones in the light theme, the dark theme, and when a host sets data-theme', async ({ browser }) => {
  const light = await browser.newContext({ colorScheme: 'light' });
  let page = await light.newPage();
  await page.goto('/');
  expect(await tokens(page, Object.keys(LIGHT))).toEqual(LIGHT);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(239, 230, 214)');
  // a host (claude.ai) can force dark on a light OS
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  expect(await tokens(page, Object.keys(DARK))).toEqual(DARK);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(23, 19, 15)');
  await light.close();

  const dark = await browser.newContext({ colorScheme: 'dark' });
  page = await dark.newPage();
  await page.goto('/');
  expect(await tokens(page, Object.keys(DARK))).toEqual(DARK);
  // and force light on a dark OS
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  expect(await tokens(page, Object.keys(LIGHT))).toEqual(LIGHT);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  expect(await tokens(page, ['--paper'])).toEqual({ '--paper': DARK['--paper'] });
  await dark.close();
});

test('masthead, paper grain, fonts and the one external host', async ({ page }) => {
  const hosts = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http')) hosts.add(u.hostname);
  });
  await page.goto('/');
  const h1 = page.getByRole('heading', { name: 'Song Looper' });
  await expect(h1).toBeVisible();
  const style = await h1.evaluate((el) => {
    const s = getComputedStyle(el);
    return { stretch: s.fontStretch, weight: s.fontWeight, upper: s.textTransform, family: s.fontFamily };
  });
  expect(style.weight).toBe('800');
  expect(style.stretch).toBe('125%');
  expect(style.upper).toBe('uppercase');
  expect(style.family).toContain('Archivo');
  await expect(page.locator('header.top p')).toHaveText('Drop in a record. Press an extended cut.');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('header.top p')!).fontVariantCaps)).toBe('all-small-caps');
  // compact, never a full-height hero
  expect((await h1.boundingBox())!.height).toBeLessThan(80);

  // Google Fonts: Archivo (variable width 62-125, weight 400-800) and IBM Plex Mono 400/600 with display=swap
  const href = await page.locator('link[rel=stylesheet][href*="fonts.googleapis.com"]').getAttribute('href');
  expect(href).toBe('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;600&display=swap');
  // nothing else is loaded from outside
  const outside = [...hosts].filter((h) => h !== '127.0.0.1' && h !== 'localhost');
  for (const h of outside) expect(h).toMatch(/^fonts\.(googleapis|gstatic)\.com$/);

  // paper grain: an inline SVG feTurbulence data URI at 4% opacity or less, and no image files
  const grain = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
  expect(grain).toContain('data:image/svg+xml');
  const decoded = decodeURIComponent(grain);
  expect(decoded).toContain('feTurbulence');
  const opacity = Number(/opacity='([\d.]+)'/.exec(decoded)![1]);
  expect(opacity).toBeLessThanOrEqual(0.04);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(e.name)).length)).toBe(0);
});

test('with Google Fonts blocked, the fallbacks take over and nothing breaks', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 380, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(page.getByRole('heading', { name: 'Song Looper' })).toBeVisible();
  await expect(page.getByTestId('play')).toBeVisible();
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
  expect(loaded).toBe(0);
  // the app still works, and the page still fits a phone
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.getByTestId('play').click();
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  expect(errors).toEqual([]);
  await context.close();
});

test('the drop zone is a record sleeve, and a sleeve strip once a song is in', async ({ page }) => {
  await page.goto('/');
  const zone = page.getByTestId('dropzone');
  await expect(zone).toContainText('Drop a song here or click to choose');
  await expect(zone.locator('.sleeve-record')).toBeVisible();
  const box = (await zone.locator('.sleeve-face').boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(2); // a square card
  const record = (await zone.locator('.sleeve-record').boundingBox())!;
  expect(record.y).toBeLessThan(box.y); // the record peeks out of the top edge
  expect(record.y + record.height).toBeGreaterThan(box.y);
  const fixture = await clickTrackFixture(120, 20);
  await loadFixture(page, fixture);
  await expect(zone).toHaveClass(/compact/);
  const strip = (await zone.locator('.sleeve-face').boundingBox())!;
  expect(strip.height).toBeLessThan(100);
  const meta = page.getByTestId('file-meta');
  await expect(meta).toHaveText(/^0:20 · 44\.1 kHz · stereo$/);
  expect(await meta.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Mono');
  await expect(page.getByTestId('file-name')).toHaveText(fixture.name);
});

test('the turntable bar: the record is the play button and spins at 1.8 s / speed per turn, stops in place, and rests with reduced motion', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);

  const record = page.locator('[data-testid=play] .record');
  const rb = (await record.boundingBox())!;
  expect(rb.width).toBeGreaterThanOrEqual(72);
  expect(rb.height).toBeGreaterThanOrEqual(72);
  await expect(page.getByTestId('play')).toHaveText('Play');
  // vinyl base, grooves and a red centre label
  const look = await page.evaluate(() => {
    const disc = document.querySelector('[data-testid=play] .record-disc') as HTMLElement;
    const label = document.querySelector('[data-testid=play] .record-label') as HTMLElement;
    return { discBg: getComputedStyle(disc).backgroundImage, labelBg: getComputedStyle(label).backgroundColor, radius: getComputedStyle(disc).borderRadius };
  });
  expect(look.discBg).toContain('repeating-radial-gradient');
  expect(look.labelBg).toBe('rgb(198, 55, 44)');
  expect(look.radius).toMatch(/50%/);

  const spin = (): Promise<{ state: string; duration: number | string; rate: number; time: number } | null> =>
    page.evaluate(() => {
      const disc = document.querySelector('[data-testid=play] .record-disc') as HTMLElement;
      const a = disc.getAnimations()[0];
      if (!a) return null;
      return {
        state: a.playState,
        duration: (a.effect as KeyframeEffect).getComputedTiming().duration as number,
        rate: a.playbackRate,
        time: Number(a.currentTime),
      };
    });

  expect(await spin()).toBeNull(); // not spinning before it plays
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.waitForTimeout(700); // the spin eases in over 400 ms
  let s = (await spin())!;
  expect(s.state).toBe('running');
  expect(s.duration).toBe(1800);
  expect(s.rate).toBeCloseTo(1, 2);
  // one turn takes 1.8 s: after a second the disc has moved 1/1.8 of a turn more
  const t0 = (await spin())!.time;
  await page.waitForTimeout(1000);
  const dt = (await spin())!.time - t0;
  expect(dt).toBeGreaterThan(900);
  expect(dt).toBeLessThan(1150);

  // speed changes how fast it turns: 1.25x is 1.44 s a turn
  await page.getByTestId('speed-input').fill('1.25');
  await page.getByTestId('speed-input').press('Enter');
  await page.waitForTimeout(300);
  s = (await spin())!;
  expect(s.rate).toBeCloseTo(1.25, 3);
  const u0 = s.time;
  await page.waitForTimeout(1000);
  const du = (await spin())!.time - u0;
  expect(du).toBeGreaterThan(1150);
  expect(du).toBeLessThan(1400);

  // paused: it stops where it is, and does not snap back
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
  await page.waitForTimeout(150); // a pause takes effect on the next frame
  const stopped = (await spin())!;
  expect(stopped.state).toBe('paused');
  await page.waitForTimeout(400);
  const later = (await spin())!;
  expect(later.state).toBe('paused');
  expect(later.time).toBe(stopped.time);
  expect(stopped.time).toBeGreaterThan(0);
  // and resumes from there
  await page.getByTestId('play').click();
  await page.waitForTimeout(700);
  expect((await spin())!.time).toBeGreaterThan(stopped.time);
  await page.getByTestId('play').click();

  // needle drop: the label scales 0.96 -> 1 over 150 ms
  const drop = await page.evaluate(async () => {
    (document.querySelector('[data-testid=play]') as HTMLButtonElement).click();
    const label = document.querySelector('[data-testid=play] .record-label') as HTMLElement;
    for (let i = 0; i < 120; i++) {
      const a = label.getAnimations()[0];
      if (a) {
        const frames = (a.effect as KeyframeEffect).getKeyframes().map((k) => k.transform);
        return { frames, duration: (a.effect as KeyframeEffect).getComputedTiming().duration as number };
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { frames: [], duration: 0 };
  });
  expect(drop.frames).toEqual(['scale(0.96)', 'scale(1)']);
  expect(drop.duration).toBe(150);
  await page.getByTestId('play').click();
  expect(errors).toEqual([]);
  await context.close();

  // reduced motion: no spin at all
  const calm = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  const still = await calm.newPage();
  await loadFixture(still, await makeChordFixture(SONG1, 'song1.wav'));
  await still.getByTestId('play').click();
  await expect(still.getByTestId('play')).toHaveText('Pause');
  await still.waitForTimeout(600);
  expect(await still.evaluate(() => (document.querySelector('[data-testid=play] .record-disc') as HTMLElement).getAnimations().length)).toBe(0);
  await calm.close();
});

test('the turntable bar on a phone: record 60 px, time, Play and Export visible, speed and pitch folded away', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 380, height: 800 } });
  const page = await context.newPage();
  const fixture = await clickTrackFixture(120, 20);
  await loadFixture(page, fixture);
  const rb = (await page.locator('[data-testid=play] .record').boundingBox())!;
  expect(rb.width).toBeGreaterThanOrEqual(60);
  expect(rb.width).toBeLessThan(66);
  for (const id of ['play', 'time', 'export']) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('play')).toContainText('Play');
  // speed and pitch are folded away until opened
  await expect(page.getByTestId('speed-input')).toBeHidden();
  await page.locator('summary', { hasText: 'Speed & pitch' }).click();
  await expect(page.getByTestId('speed-input')).toBeVisible();
  // the bar stays inside the screen and inside the safe area
  const bar = (await page.locator('.transport').boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(380);
  expect(await page.locator('.transport').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
  expect(await appState<number>(page, 's.song.duration')).toBeGreaterThan(19);
  await context.close();
});

test('A · Original and B · Extended are the two sides; Export WAV is the strongest button, a solid red pill', async ({ page }) => {
  await loadFixture(page, await clickTrackFixture(120, 20));
  await expect(page.getByTestId('mode-original')).toHaveText('A · Original');
  await expect(page.getByTestId('mode-extended')).toHaveText('B · Extended');
  await expect(page.getByTestId('mode-original')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('mode-extended').click();
  await expect(page.getByTestId('mode-extended')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mode-original')).toHaveAttribute('aria-pressed', 'false');
  const exp = await page.getByTestId('export').evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: parseFloat(s.borderRadius), height: el.getBoundingClientRect().height };
  });
  expect(exp.bg).toBe('rgb(198, 55, 44)');
  expect(exp.radius).toBeGreaterThanOrEqual(exp.height / 2 - 1);
  // times are in the monospace face
  expect(await page.getByTestId('time').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Mono');
  // every button gets a mustard focus ring
  await page.getByTestId('export').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await page.getByTestId('export').evaluate((el) => getComputedStyle(el).outlineColor);
  expect(ring).toBe('rgb(214, 160, 61)');
});
