import { expect, test } from '@playwright/test';
import { dragSelect, loadFixture, makeFixture, parseWav } from './helpers';

// Inside a claude.ai artifact the page can't start downloads. It asks the
// host through `claude.use("downloads")`, which takes .zip but not .wav.
// This fakes that host and checks the export arrives as a zip holding the WAV.

interface Saved {
  filename: string;
  bytes: number[];
}

test('inside a claude.ai artifact, export saves a zip containing the WAV', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { claude: unknown; __saved?: Saved };
    w.claude = {
      use: async (name: string) =>
        name === 'downloads'
          ? {
              save: async (req: { filename: string; data: Blob }) => {
                w.__saved = { filename: req.filename, bytes: Array.from(new Uint8Array(await req.data.arrayBuffer())) };
                return { status: 'saved' };
              },
            }
          : null,
    };
  });

  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 2 });
  await loadFixture(page, fixture);
  await dragSelect(page, 0.2, 0.5);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);

  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await page.getByTestId('export').click();
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-dialog')).toBeHidden();

  const saved = await page.evaluate(() => (window as unknown as { __saved?: Saved }).__saved);
  expect(downloaded).toBe(false);
  expect(saved?.filename).toMatch(/\(extended\)\.zip$/);

  // Stored zip: local header is 30 bytes + name, then the raw WAV bytes.
  const zip = Buffer.from(saved!.bytes);
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const size = zip.readUInt32LE(18);
  const nameLen = zip.readUInt16LE(26);
  expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toMatch(/\(extended\)\.wav$/);
  const wav = parseWav(zip.subarray(30 + nameLen, 30 + nameLen + size));
  expect(wav.riffSizeOk).toBe(true);
  expect(wav.duration).toBeGreaterThan(fixture.duration);
});
