import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { dragSelect, loadFixture, makeFixture, parseWav } from './helpers';

// Inside a claude.ai artifact the page cannot start downloads; src/audio/save.ts asks the host, which takes a .zip. A loop
// file goes the same way as the extended song: zipped.

interface Saved {
  filename: string;
  byteLength: number;
  bytes: number[];
}

async function fakeClaudeHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { claude: unknown; __saved?: Saved };
    w.claude = {
      use: async (name: string) =>
        name === 'downloads'
          ? {
              save: async (req: { filename: string; data: Blob }) => {
                const all = new Uint8Array(await req.data.arrayBuffer());
                w.__saved = { filename: req.filename, byteLength: all.length, bytes: Array.from(all) };
                return { status: 'saved' };
              },
            }
          : null,
    };
  });
}

test('inside a claude.ai artifact, Export loop saves a zip holding the loop file, as long as the loop', async ({ page }) => {
  await fakeClaudeHost(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeFixture({ structure: 'AB', barsPerSection: 4 }, 'Artifact Song.wav');
  await loadFixture(page, fixture);
  await dragSelect(page, 0.2, 0.5);
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid=regions] li')).toHaveCount(1);
  const [loop] = await page.evaluate(() => (window as unknown as { songLooper: { store: { get(): { regions: { start: number; end: number; seam?: { loopStart: number; loopEnd: number } }[] } } } }).songLooper.store.get().regions);
  const len = loop!.seam ? loop!.seam.loopEnd - loop!.seam.loopStart : loop!.end - loop!.start;

  let downloaded = false;
  page.on('download', () => (downloaded = true));
  for (const repeats of [1, 4]) {
    await page.evaluate(() => delete (window as unknown as { __saved?: Saved }).__saved);
    await page.getByTestId('export-loop').first().click();
    await page.getByTestId('export-repeats').fill(String(repeats));
    await page.getByTestId('export-repeats').press('Enter');
    await page.getByTestId('export-confirm').click();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    const saved = await page.evaluate(() => (window as unknown as { __saved?: Saved }).__saved);
    expect(downloaded).toBe(false);
    // a zip named like the loop file
    expect(saved?.filename).toMatch(/^Artifact Song - Loop 1 \(\d\.\d\d\.\d\d\d-\d\.\d\d\.\d\d\d\)\.zip$/);
    const zip = Buffer.from(saved!.bytes);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const size = zip.readUInt32LE(18);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toMatch(/^Artifact Song - Loop 1 \(.*\)\.wav$/);
    const wav = parseWav(zip.subarray(30 + nameLen, 30 + nameLen + size));
    expect(wav.riffSizeOk).toBe(true);
    expect(Math.abs(wav.duration - repeats * len)).toBeLessThan(0.03);
  }
  expect(errors).toEqual([]);
});
