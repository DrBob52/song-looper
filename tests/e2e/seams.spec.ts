import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { loadFixture, makeChordFixture, waitForAnalysis } from './helpers';

/** Add a loop on a span of the song through the app (as the Add button would). */
async function addLoop(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ([a, b]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({
        start: a!,
        end: b!,
      }),
    [start, end],
  );
}

test('the seam chip reads Rough for a loop whose chord change is not in the song, and not for one that is', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const [a, b] = fixture.sections;

  // Loop A (C G Am F) ends on F and returns to C: the song never makes that change.
  await addLoop(page, a!.start, a!.end);
  const chip = page.getByTestId('seam-chip').first();
  await expect(chip).toHaveText('Rough');
  await expect(chip).toHaveAttribute('data-chip', 'rough');
  await expect(chip).toHaveAttribute('title', /never makes this chord change/);

  // Loop A+B ends on G and returns to C, which the song does at the end of its first B.
  await page.getByTestId('remove-loop').click();
  await addLoop(page, a!.start, b!.end);
  await expect(page.getByTestId('seam-chip').first()).not.toHaveText('Rough');
  await expect(page.getByTestId('seam-chip').first()).toHaveAttribute('title', /makes this chord change itself/);

  // moving a loop's edge asks again
  await page.getByTestId('remove-loop').click();
  await addLoop(page, a!.start, a!.end);
  await expect(page.getByTestId('seam-chip').first()).toHaveText('Rough');
  expect(errors).toEqual([]);
});
