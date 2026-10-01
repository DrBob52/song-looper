import { expect, test } from './fixtures';

// The Chromium build used for tests ships without AAC, and no Chrome or
// Firefox build can decode Apple Lossless, so these load through the bundled
// fallback decoder. Files come from scripts/make-m4a-fixtures.sh.
for (const [file, meta] of [
  ['tone-aac.m4a', /0:06 · 44\.1 kHz · stereo/],
  ['tone-alac.m4a', /0:04 · 22\.05 kHz · mono/],
] as const) {
  test(`loads ${file}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.setInputFiles('[data-testid=file-input]', `tests/fixtures/${file}`);
    await page.waitForSelector('[data-testid=song-panel]:not([hidden])');
    await expect(page.getByTestId('file-meta')).toHaveText(meta);
    await expect(page.getByTestId('error')).toBeHidden();
    expect(errors).toEqual([]);
  });
}
