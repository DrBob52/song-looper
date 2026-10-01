import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { clickTrackFixture, loadFixture, waitForAnalysis } from './helpers';

// Opt-in: BIG_EXPORT_SECONDS=14400 BIG_EXPORT_BITS=16 npx playwright test big-export
// With BIG_EXPORT_ARTIFACT=1 the page pretends to be a claude.ai artifact, so the file is zipped before saving.
// Exports a very long extended song through the real UI and checks the WAV header against the file on disk.
// It runs in a persistent browser profile: Playwright's default (incognito-like) contexts keep blobs in memory only
// and cannot hold a file over about 2 GiB, whereas a normal Chrome profile pages them to disk.
const seconds = Number(process.env.BIG_EXPORT_SECONDS ?? 0);
const bits = Number(process.env.BIG_EXPORT_BITS ?? 16) as 16 | 24 | 32;
test.skip(!seconds, 'set BIG_EXPORT_SECONDS to run');

test(`export of ${seconds} s at ${bits}-bit`, async ({ baseURL }) => {
  test.setTimeout(3_600_000);
  const profile = mkdtempSync(join(tmpdir(), 'looper-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
    acceptDownloads: true,
    baseURL,
  });
  const page = await context.newPage();
  const asArtifact = process.env.BIG_EXPORT_ARTIFACT === '1';
  if (asArtifact) {
    await page.addInitScript(() => {
      const w = window as unknown as { claude: unknown; __saved?: { filename: string; size: number; head: number[]; ms: number } };
      w.claude = {
        use: async (name: string) =>
          name === 'downloads'
            ? {
                save: async (req: { filename: string; data: Blob }) => {
                  const t = performance.now();
                  const head = new Uint8Array(await req.data.slice(0, 4096).arrayBuffer());
                  w.__saved = { filename: req.filename, size: req.data.size, head: Array.from(head), ms: performance.now() - t };
                  return { status: 'saved' };
                },
              }
            : null,
      };
    });
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  // a 10 s loop on silent stretches of the click track (so the length is exact), repeated to reach the length
  const repeats = Math.min(9999, Math.round((seconds - 30) / 10) + 1);
  await page.evaluate(() =>
    (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: 4.75, end: 15.75 }),
  );
  const startField = page.getByTestId('loop-start').first();
  await startField.fill('5.25');
  await startField.press('Enter');
  const endField = page.getByTestId('loop-end').first();
  await endField.fill('15.25');
  await endField.press('Enter');
  const r = page.getByTestId('repeats').first();
  await r.fill(String(repeats));
  await r.press('Enter');
  const expected = 30 + (repeats - 1) * 10;
  await page.getByTestId('export').click();
  if (bits !== 16) await page.getByTestId(`depth-${bits}`).check();
  page.on('console', (m) => process.stdout.write(`[page ${m.type()}] ${m.text()}\n`));
  const t0 = Date.now();
  if (asArtifact) {
    await page.getByTestId('export-confirm').click();
    await expect(page.getByTestId('export-dialog')).toBeHidden({ timeout: 3_000_000 });
    const saved = await page.evaluate(() => (window as unknown as { __saved: { filename: string; size: number; head: number[] } }).__saved);
    const zip = Buffer.from(saved.head);
    const nameLen = zip.readUInt16LE(26);
    const wavSize = zip.readUInt32LE(18);
    const wav = zip.subarray(30 + nameLen, 30 + nameLen + 44);
    const dataBytes = wav.readUInt32LE(40);
    process.stdout.write(
      `BIG EXPORT (artifact zip): ${expected} s at ${bits}-bit: zip ${saved.filename} ${(saved.size / 1e9).toFixed(3)} GB in ${((Date.now() - t0) / 1000).toFixed(1)} s; ` +
        `stored size ${wavSize}, wav data ${dataBytes}, zip total ${saved.size}\n`,
    );
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(dataBytes).toBe(wavSize - 44);
    expect(saved.size).toBeLessThan(4_294_967_295);
    expect(saved.size).toBeGreaterThan(wavSize);
    expect(errors).toEqual([]);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    return;
  }
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 3_500_000 }), page.getByTestId('export-confirm').click()]);
  process.stdout.write(`download started after ${((Date.now() - t0) / 1000).toFixed(1)} s (${download.suggestedFilename()})\n`);
  const path = await download.path().catch(async (e: Error) => {
    const banner = await page.getByTestId('export-error').textContent().catch(() => '');
    process.stdout.write(`download failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${e.message}; failure=${await download.failure()}; banner=${banner}\n`);
    throw e;
  });
  const took = (Date.now() - t0) / 1000;
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(44);
  readSync(fd, buf, 0, 44, 0);
  closeSync(fd);
  const size = statSync(path).size;
  const dataBytes = buf.readUInt32LE(40);
  const channels = buf.readUInt16LE(22);
  const bps = buf.readUInt16LE(34);
  const rate = buf.readUInt32LE(24);
  const duration = dataBytes / (channels * (bps / 8)) / rate;
  process.stdout.write(
    `BIG EXPORT: ${expected} s (${Math.floor(expected / 3600)}:${String(Math.floor((expected % 3600) / 60)).padStart(2, '0')}:${String(expected % 60).padStart(2, '0')}) at ${bits}-bit: ` +
      `${(size / 1e9).toFixed(3)} GB in ${took.toFixed(1)} s; header data ${dataBytes} bytes = ${duration} s; riff ${buf.readUInt32LE(4)} (file ${size})\n`,
  );
  expect(dataBytes).toBe(size - 44);
  expect(buf.readUInt32LE(4)).toBe(size - 8);
  expect(duration).toBeCloseTo(expected, 6);
  expect(errors).toEqual([]);
  unlinkSync(path);
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});
