import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import { appState, clickTrackFixture, dragSelect, loadFixture, parseWav, waitForAnalysis, wavFixture } from './helpers';
import { sine, synthSong } from '../fixtures/synth';

function noise(n: number, amp = 0.3): Float32Array {
  let x = 987654321;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = (x / 2147483648 - 1) * amp;
  }
  return out;
}

test('silent audio: clear message, manual loops and export still work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await wavFixture([new Float32Array(44100 * 25)], 44100, 'silence.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(page.getByTestId('analysis-message')).toContainText('looks silent');
  await expect(page.getByTestId('suggestions-note')).toContainText('silent');
  await dragSelect(page, 0.2, 0.4);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const info = parseWav(readFileSync(await download.path()));
  expect(info.duration).toBeGreaterThan(25);
  expect(errors).toEqual([]);
});

test('noise has no steady beat: warns and falls back to a 0.5 s snapping grid', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await wavFixture([noise(44100 * 25)], 44100, 'noise.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(page.getByTestId('analysis-message')).toContainText('No steady beat found');
  expect(await appState<boolean>(page, 's.grid.steady')).toBe(false);
  // no beat grid is drawn
  const lines = await page.evaluate(() => {
    const host = document.querySelector('[data-testid=waveform] > div');
    return host?.shadowRoot?.querySelectorAll('svg line').length ?? 0;
  });
  expect(lines).toBe(0);
  // selections still snap: to the fixed 0.5 s grid
  await dragSelect(page, 0.23, 0.51);
  await page.keyboard.press('l');
  const [r] = await appState<{ start: number; end: number }[]>(page, 's.regions');
  expect(Math.abs(r!.start / 0.5 - Math.round(r!.start / 0.5))).toBeLessThan(1e-6);
  expect(Math.abs(r!.end / 0.5 - Math.round(r!.end / 0.5))).toBeLessThan(1e-6);
  expect(errors).toEqual([]);
});

test('a sustained tone with no beats gives a message and no suggestions', async ({ page }) => {
  const fixture = await wavFixture([sine(220, 30, 44100, 0.4)], 44100, 'drone.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(page.getByTestId('analysis-message')).toContainText(/No (steady beat|beats) found/);
  // either no suggestions at all, or a clear "may be rough" caveat above them
  await expect(page.getByTestId('suggestions-note').first()).toContainText(/No beats were found|No steady beat found/);
});

test('very short songs skip suggestions but still allow manual loops', async ({ page }) => {
  const fixture = await wavFixture([sine(330, 3, 44100, 0.4)], 44100, 'short.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await expect(page.getByTestId('suggestions-note')).toContainText('under 20 seconds');
  await dragSelect(page, 0.2, 0.6);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const info = parseWav(readFileSync(await download.path()));
  expect(info.duration).toBeGreaterThan(3);
});

test('an empty or unsupported file shows an error and leaves the app usable', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('[data-testid=file-input]', { name: 'empty.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(0) });
  await expect(page.getByTestId('error')).toContainText('could not be decoded');
  await page.setInputFiles('[data-testid=file-input]', {
    name: 'picture.png',
    mimeType: 'image/png',
    buffer: Buffer.from('\x89PNG\r\n\x1a\n not audio', 'latin1'),
  });
  await expect(page.getByTestId('error')).toContainText('could not be decoded');
  // a good file afterwards clears the error
  const fixture = await clickTrackFixture(100, 12);
  await page.setInputFiles('[data-testid=file-input]', { name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
  await page.waitForSelector('[data-testid=song-panel]:not([hidden])');
  await expect(page.getByTestId('error')).toBeHidden();
});

test('mono files and other sample rates are rendered and exported at their native format', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const [rate, channels] of [
    [48000, 1],
    [22050, 2],
    [32000, 1],
  ] as const) {
    const song = synthSong({ sampleRate: rate, structure: 'ABAB', barsPerSection: 4 });
    const chans = channels === 1 ? [song.samples] : [song.samples, song.samples];
    const fixture = await wavFixture(chans, rate, `rate-${rate}.wav`);
    await loadFixture(page, fixture);
    await waitForAnalysis(page);
    await expect(page.getByTestId('file-meta')).toContainText(channels === 1 ? 'mono' : 'stereo');
    await expect(page.getByTestId('file-meta')).toContainText(`${rate / 1000}`);
    await page.getByTestId('waveform').scrollIntoViewIfNeeded();
    await dragSelect(page, 0.25, 0.55);
    await page.keyboard.press('l');
    await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
    const [reg] = await appState<{ start: number; end: number; repeats: number }[]>(page, 's.regions');
    const expected = fixture.duration + (reg!.repeats - 1) * (reg!.end - reg!.start);
    await page.getByTestId('export').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
    const info = parseWav(readFileSync(await download.path()));
    expect(info.sampleRate).toBe(rate);
    expect(info.channels).toBe(channels);
    expect(Math.abs(info.duration - expected)).toBeLessThan(0.02);
  }
  expect(errors).toEqual([]);
});

test('layout fits a 380px wide screen in light and dark mode', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 380, height: 800 }, colorScheme: scheme });
    const page = await context.newPage();
    const fixture = await clickTrackFixture(120, 30);
    await loadFixture(page, fixture);
    await waitForAnalysis(page);
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = bg.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
    if (scheme === 'dark') expect(lum).toBeLessThan(60);
    else expect(lum).toBeGreaterThan(200);
    // key controls remain reachable
    await expect(page.getByTestId('play')).toBeVisible();
    await expect(page.getByTestId('export')).toBeVisible();
    await context.close();
  }
});
