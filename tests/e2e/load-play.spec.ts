import { expect, test } from './fixtures';
import { loadFixture, makeFixture } from './helpers';

test('loads a file, shows the waveform and plays', async ({ page }) => {
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 2 });
  await loadFixture(page, fixture);

  await expect(page.getByTestId('file-name')).toHaveText(fixture.name);
  await expect(page.getByTestId('file-meta')).toContainText('44.1 kHz');
  await expect(page.getByTestId('file-meta')).toContainText('stereo');

  // wavesurfer renders canvases inside a shadow root
  await expect
    .poll(() => page.evaluate(() => {
      const host = document.querySelector('[data-testid=waveform] > div');
      return host?.shadowRoot?.querySelectorAll('canvas').length ?? 0;
    }))
    .toBeGreaterThan(0);

  const time = page.getByTestId('time');
  await expect(time).toContainText('0:00.0 /');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Pause');
  await expect(time).not.toContainText('0:00.0 /');
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Play');
});

test('shows an error for a file that is not audio', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('[data-testid=file-input]', {
    name: 'notes.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('this is definitely not audio data'),
  });
  await expect(page.getByTestId('error')).toContainText('could not be decoded');
});
