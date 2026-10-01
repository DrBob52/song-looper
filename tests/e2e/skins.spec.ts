import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SKINS } from '../../src/ui/skins';
import type { SkinId } from '../../src/ui/skins';
import { SONG1, sine } from '../fixtures/synth';
import { loadFixture, makeChordFixture, makeFixture, waitForAnalysis, wavFixture } from './helpers';

// SPEC-v1.3.md 5: skins. Every skin shares the markup and test ids; the picker in the masthead switches them.

/** The skins that exist so far; each milestone adds its own. */
const READY: SkinId[] = ['vinyl', 'studio', 'club', 'pro'];

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

// ---- Studio hardware ----

const rgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

test('Studio: the spec tokens whatever the host says, an amber LCD for the time, a square pad ringed with LEDs', async ({ browser }) => {
  const TOKENS = {
    '--bg': '#141517',
    '--panel': '#1e2023',
    '--panel-2': '#262a2e',
    '--ink': '#ece8df',
    '--ink-soft': '#9b978e',
    '--rule': '#33373c',
    '--accent': '#ffb000',
    '--lcd-bg': '#231a00',
    '--led-green': '#3ddc6a',
    '--led-amber': '#ffb000',
    '--led-red': '#ff4a3d',
    '--loop-1': '#ffb000',
    '--loop-2': '#38c6d9',
    '--loop-3': '#e2559c',
    '--loop-4': '#3ddc6a',
    '--loop-5': '#d9d4c7',
  };
  // a light host and a dark host (and a host that forces light with data-theme): the same dark look
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('song-looper-skin', 'studio'));
    await page.goto('/');
    for (const [name, v] of Object.entries(TOKENS)) expect(await tokenOf(page, name), `${scheme} ${name}`).toBe(v);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await tokenOf(page, '--bg')).toBe('#141517');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 21, 23)');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('song-looper-skin', 'studio'));
  await loadFixture(page, await makeChordFixture(SONG1, 'song1.wav'));
  await waitForAnalysis(page);
  // the time readout: VT323 in amber on the LCD background, with a glow
  const lcd = await page.getByTestId('time').evaluate((el) => {
    const s = getComputedStyle(el);
    return { family: s.fontFamily, color: s.color, bg: s.backgroundColor, glow: s.textShadow };
  });
  expect(lcd.family).toMatch(/^VT323/);
  expect(lcd.color).toBe(rgb('#ffb000'));
  expect(lcd.bg).toBe(rgb('#231a00'));
  expect(lcd.glow).not.toBe('none');
  // labels: IBM Plex Sans Condensed, uppercase and letter-spaced; numbers in IBM Plex Mono
  const label = await page.locator('.card-head h2').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { family: s.fontFamily, upper: s.textTransform, spacing: parseFloat(s.letterSpacing), weight: s.fontWeight };
  });
  expect(label.family).toMatch(/^["']IBM Plex Sans Condensed["']/);
  expect(label.upper).toBe('uppercase');
  expect(label.spacing).toBeGreaterThan(1);
  expect(['500', '600']).toContain(label.weight);
  expect(await page.getByTestId('length-extended').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('VT323');
  expect(await page.locator('input.nf-input').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Mono');
  // panels: a 1 px top bevel, corner screws (four radial dots), a 6 px radius
  const panel = await page.locator('.card').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, shadow: s.boxShadow, image: s.backgroundImage };
  });
  expect(panel.radius).toBe('6px');
  expect(panel.shadow).toMatch(/rgba\(255, 255, 255, 0\.\d+\) 0px 1px 0px 0px inset/); // the bevel: a 1 px light line on top
  expect(panel.image.match(/radial-gradient/g)).toHaveLength(4);
  // the pad: 72 px, square (rounded), with a ring of LEDs around it that is dim until it plays and then lights amber
  const pad = await page.locator('[data-testid=play] .record').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) };
  });
  expect(pad.w).toBe(72);
  expect(pad.h).toBe(72);
  expect(pad.radius).toBeLessThan(20);
  const ring = (): Promise<{ image: string; mask: string; spinning: number }> =>
    page.locator('[data-testid=play] .record-disc').evaluate((el) => {
      const s = getComputedStyle(el);
      return { image: s.backgroundImage, mask: s.maskImage || s.webkitMaskImage, spinning: el.getAnimations().filter((a) => a.playState === 'running').length };
    });
  const idle = await ring();
  expect(idle.image).toBe('none');
  expect(idle.mask).toContain('repeating-conic-gradient');
  expect(idle.spinning).toBe(0);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await page.waitForTimeout(700);
  const playing = await ring();
  expect(playing.image).toContain('conic-gradient');
  expect(playing.spinning).toBe(1); // the LED head chases around, once every 1.8 s / speed
  await page.getByTestId('play').click();
  // the seam stamp: a three-LED meter and its label: CLEAN 3 green, OK 2 amber, ROUGH 1 red
  const meters = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const kind of ['clean', 'ok', 'rough']) {
      const chip = document.createElement('span');
      chip.className = `chip chip-${kind}`;
      chip.textContent = kind.toUpperCase();
      document.body.append(chip);
      out[kind] = getComputedStyle(chip, '::before').backgroundImage;
      chip.remove();
    }
    return out;
  });
  // one radial gradient is one LED: count the LEDs of a colour
  const lit = (image: string, color: string): number => image.split('radial-gradient(').filter((led) => led.includes(color)).length;
  expect(lit(meters.clean!, 'rgb(61, 220, 106)')).toBe(3);
  expect(lit(meters.ok!, 'rgb(255, 176, 0)')).toBe(2);
  expect(lit(meters.ok!, 'rgb(58, 61, 66)')).toBe(1);
  expect(lit(meters.rough!, 'rgb(255, 74, 61)')).toBe(1);
  expect(lit(meters.rough!, 'rgb(58, 61, 66)')).toBe(2);
  // the waveform: amber on the LCD
  expect(await page.evaluate(() => (window as unknown as { songLooper: { waveform: { instance: { options: { waveColor: string } } } } }).songLooper.waveform.instance.options.waveColor)).toBe('#ffb000');
  await context.close();
});

// ---- Night club ----

test('Club: the spec tokens, neon on near-black whatever the host says, a gradient waveform and a conic ring', async ({ browser }) => {
  const TOKENS = {
    '--bg': '#07060b',
    '--panel': '#110f19',
    '--panel-2': '#191526',
    '--ink': '#f4f1ff',
    '--ink-soft': '#a49fbd',
    '--magenta': '#ff2fb9',
    '--cyan': '#19e3ff',
    '--loop-1': '#ff2fb9',
    '--loop-2': '#19e3ff',
    '--loop-3': '#ffd23f',
    '--loop-4': '#7cff6b',
    '--loop-5': '#b388ff',
  };
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('song-looper-skin', 'club'));
  await page.goto('/');
  for (const [name, v] of Object.entries(TOKENS)) expect(await tokenOf(page, name), name).toBe(v);
  // rgba(255, 47, 185, 0.18): the build writes it as #ff2fb92e (the same colour, alpha 0x2e / 255 = 0.18)
  expect(['rgba(255, 47, 185, 0.18)', '#ff2fb92e']).toContain(await tokenOf(page, '--rule'));
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(7, 6, 11)');
  // no purple-to-blue gradient on the page: the body has no background image
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe('none');
  await context.close();

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('song-looper-skin', 'club'));
  await loadFixture(p, await makeFixture({ structure: 'AB', barsPerSection: 4 }));
  await waitForAnalysis(p);
  // type: Unbounded display, Manrope text, JetBrains Mono numbers
  expect(await p.locator('header.top h1').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^Unbounded/);
  expect(['700', '800']).toContain(await p.locator('header.top h1').evaluate((el) => getComputedStyle(el).fontWeight));
  expect(await p.locator('body').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^Manrope/);
  expect(await p.getByTestId('time').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^["']JetBrains Mono["']/);
  // the waveform is a magenta to cyan gradient with a glow around its container
  expect(await p.evaluate(() => (window as unknown as { songLooper: { waveform: { instance: { options: { waveColor: unknown } } } } }).songLooper.waveform.instance.options.waveColor)).toEqual(['#ff2fb9', '#19e3ff']);
  expect(await p.getByTestId('waveform').evaluate((el) => getComputedStyle(el).filter)).toContain('drop-shadow');
  // cards: dark glass with a glowing 1 px border; the play button a big round one with a conic magenta/cyan ring
  const card = await p.locator('.card').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, color: s.borderTopColor, glow: s.boxShadow };
  });
  expect(card.border).toBe('1px');
  expect(card.glow).toContain('rgba(255, 47, 185');
  const ring = await p.locator('[data-testid=play] .record').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, ring: getComputedStyle(el, '::before').backgroundImage, glow: getComputedStyle(el, '::before').filter };
  });
  expect(ring.w).toBe(76);
  expect(ring.h).toBe(76);
  expect(ring.ring).toContain('conic-gradient');
  expect(ring.ring).toContain('rgb(255, 47, 185)');
  expect(ring.ring).toContain('rgb(25, 227, 255)');
  expect(ring.glow).toContain('drop-shadow');
  await ctx.close();
});

test('Club: the play ring and the played part of the waveform pulse on each beat, and only with a steady beat and motion', async ({ browser }) => {
  test.setTimeout(120_000);
  /** Count how often the `beat` class comes and goes on the play button and the waveform over `ms`, frame by frame. */
  const pulses = (page: Page, ms: number): Promise<{ play: number; wave: number; on: number; frames: number }> =>
    page.evaluate(
      (duration) =>
        new Promise((resolve) => {
          const play = document.querySelector('[data-testid=play]')!;
          const wave = document.querySelector('[data-testid=waveform]')!;
          let lastPlay = false;
          let lastWave = false;
          const out = { play: 0, wave: 0, on: 0, frames: 0 };
          const start = performance.now();
          const frame = (): void => {
            const p = play.classList.contains('beat');
            const w = wave.classList.contains('beat');
            if (p && !lastPlay) out.play++;
            if (w && !lastWave) out.wave++;
            if (p) out.on++;
            lastPlay = p;
            lastWave = w;
            out.frames++;
            if (performance.now() - start < duration) requestAnimationFrame(frame);
            else resolve(out);
          };
          requestAnimationFrame(frame);
        }),
      ms,
    );

  const open = async (options: { skin: string; reduced?: boolean; steady?: boolean }): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: options.reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    await page.addInitScript((id) => localStorage.setItem('song-looper-skin', id), options.skin);
    // a steady 120 BPM song, or a sustained tone with no beat
    const fixture =
      options.steady === false ? await wavFixture([sine(220, 14, 44100, 0.4), sine(220, 14, 44100, 0.4)], 44100, 'tone.wav') : await makeChordFixture(SONG1, 'song1.wav');
    await loadFixture(page, fixture);
    await waitForAnalysis(page);
    return { page, close: () => context.close() };
  };

  // club, steady beat: a pulse on every beat (120 BPM: one every half second), brief (about 0.11 s of each 0.5 s)
  let ctx = await open({ skin: 'club' });
  expect(await ctx.page.evaluate(() => (window as unknown as { songLooper: { store: { get(): { grid: { steady: boolean } } } } }).songLooper.store.get().grid.steady)).toBe(true);
  await ctx.page.getByTestId('play').click();
  await expect(ctx.page.getByTestId('play')).toHaveText('Pause');
  const steady = await pulses(ctx.page, 3600);
  expect(steady.play).toBeGreaterThanOrEqual(5);
  expect(steady.play).toBeLessThanOrEqual(9);
  expect(steady.wave).toBe(steady.play);
  const share = steady.on / steady.frames;
  expect(share).toBeGreaterThan(0.1);
  expect(share).toBeLessThan(0.4);
  // paused: no pulse left on
  await ctx.page.getByTestId('play').click();
  await expect(ctx.page.getByTestId('play')).toHaveText('Play');
  expect(await ctx.page.locator('[data-testid=play].beat').count()).toBe(0);
  expect(await ctx.page.locator('[data-testid=waveform].beat').count()).toBe(0);
  // changing look while it plays turns the pulse off at once
  await ctx.page.getByTestId('play').click();
  await ctx.page.waitForTimeout(300);
  await ctx.page.getByTestId('look-pro').check();
  await ctx.page.waitForTimeout(100);
  const other = await pulses(ctx.page, 1500);
  expect(other.play + other.wave).toBe(0);
  await ctx.page.getByTestId('play').click();
  await ctx.close();

  // no steady beat: nothing
  ctx = await open({ skin: 'club', steady: false });
  expect(await ctx.page.evaluate(() => (window as unknown as { songLooper: { store: { get(): { grid: { steady: boolean } } } } }).songLooper.store.get().grid.steady)).toBe(false);
  await ctx.page.getByTestId('play').click();
  await expect(ctx.page.getByTestId('play')).toHaveText('Pause');
  const none = await pulses(ctx.page, 2200);
  expect(none.play + none.wave).toBe(0);
  await ctx.close();

  // reduced motion: nothing
  ctx = await open({ skin: 'club', reduced: true });
  await ctx.page.getByTestId('play').click();
  await expect(ctx.page.getByTestId('play')).toHaveText('Pause');
  const calm = await pulses(ctx.page, 2200);
  expect(calm.play + calm.wave).toBe(0);
  await ctx.close();
});
