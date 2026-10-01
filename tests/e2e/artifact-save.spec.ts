import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { SONG1 } from '../fixtures/synth';
import { appState, dragSelect, loadFixture, makeChordFixture, makeFixture, parseWav, waitForAnalysis } from './helpers';

// Inside a claude.ai artifact the page can't start downloads. It asks the
// host through `claude.use("downloads")`, which takes .zip but not .wav.
// This fakes that host and checks the export arrives as a zip holding the WAV.

interface Saved {
  filename: string;
  /** Size of the whole file. */
  byteLength: number;
  /** The file's bytes; only the first 4 KB of a big one (copying megabytes through the test channel takes minutes). */
  bytes: number[];
}

/** Pretend to be the claude.ai host: `claude.use("downloads")` records what it is asked to save. */
async function fakeClaudeHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { claude: unknown; __saved?: Saved };
    w.claude = {
      use: async (name: string) =>
        name === 'downloads'
          ? {
              save: async (req: { filename: string; data: Blob }) => {
                const all = new Uint8Array(await req.data.arrayBuffer());
                w.__saved = { filename: req.filename, byteLength: all.length, bytes: Array.from(all.length <= 2_000_000 ? all : all.subarray(0, 4096)) };
                return { status: 'saved' };
              },
            }
          : null,
    };
  });
}

test('inside a claude.ai artifact, export saves a zip containing the WAV', async ({ page }) => {
  await fakeClaudeHost(page);

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

test('inside a claude.ai artifact, a loop with a smoothed seam and a bridge exports as a zip as long as the timeline says', async ({ page }) => {
  await fakeClaudeHost(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await makeChordFixture(SONG1, 'song1.wav');
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  const a = fixture.sections[0]!;
  await page.evaluate(
    ([start, end]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({
        start: start!,
        end: end!,
      }),
    [a.start, a.end],
  );
  await expect(page.getByTestId('seam-summary').first()).toBeVisible();
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/^Bridge: 4 bars/);
  await page.getByTestId('repeats').first().fill('3');
  await page.getByTestId('repeats').first().press('Enter');
  const { seam } = (await appState<{ seam: { loopStart: number; loopEnd: number; bridge: { seconds: number } } }[]>(page, 's.regions'))[0]!;
  const expected = fixture.duration + 2 * (seam.loopEnd - seam.loopStart + seam.bridge.seconds);

  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await page.getByTestId('export').click();
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  const saved = await page.evaluate(() => (window as unknown as { __saved?: Saved }).__saved);
  expect(downloaded).toBe(false);
  expect(saved?.filename).toMatch(/\(extended\)\.zip$/);
  // a stored zip: local header (30 bytes + name), the WAV, then the central directory. Only the WAV's header is needed.
  const zip = Buffer.from(saved!.bytes);
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const size = zip.readUInt32LE(18);
  const nameLen = zip.readUInt16LE(26);
  expect(saved!.byteLength).toBeGreaterThan(30 + nameLen + size);
  const wav = parseWav(zip.subarray(30 + nameLen, 30 + nameLen + 44));
  expect(wav.dataBytes).toBe(size - 44);
  expect(Math.abs(wav.duration - expected)).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});
