import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { Page, Worker } from '@playwright/test';
import { appState, clickTrackFixture, loadFixture, waitForAnalysis } from './helpers';

// SPEC-v1.2.md 2: repeats up to 9,999, the WAV size cap, export written piece by piece with progress and Cancel.

interface Header {
  format: number;
  channels: number;
  sampleRate: number;
  bits: number;
  dataBytes: number;
  riffSize: number;
}

/** Read just the 44-byte header (these files are hundreds of megabytes). */
function readHeader(path: string): Header & { fileBytes: number; seconds: number } {
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(44);
  readSync(fd, buf, 0, 44, 0);
  closeSync(fd);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 36, 40) !== 'data') throw new Error('not a canonical WAV file');
  const h = {
    format: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
    riffSize: buf.readUInt32LE(4),
  };
  return { ...h, fileBytes: statSync(path).size, seconds: h.dataBytes / (h.channels * (h.bits / 8)) / h.sampleRate };
}

/** A loop on silent stretches of the click track, so zero-crossing snapping leaves its edges exactly where they are. */
async function addExactLoop(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ([a, b]) =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({
        start: a! - 0.5,
        end: b! + 0.5,
      }),
    [start, end],
  );
  // exact times: smoothing off, so the loop plays exactly these points
  const startField = page.getByTestId('loop-start').first();
  await startField.fill(String(start));
  await startField.press('Enter');
  const endField = page.getByTestId('loop-end').first();
  await endField.fill(String(end));
  await endField.press('Enter');
  await expect(page.getByTestId('smooth-toggle').first()).not.toBeChecked();
}

async function setRepeats(page: Page, n: number): Promise<void> {
  const repeats = page.getByTestId('repeats').first();
  await repeats.fill(String(n));
  await repeats.press('Enter');
  await expect(repeats).toHaveValue(String(n));
}

test('a 20 minute export is written piece by piece: the header matches the timeline and nothing is the size of the song', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the biggest thing that crosses from the render worker to the page is one piece of the file
  await page.addInitScript(() => {
    const w = window as unknown as { Worker: typeof Worker; __maxPiece: number; __pieces: number };
    w.__maxPiece = 0;
    w.__pieces = 0;
    const Original = w.Worker;
    w.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', (ev: MessageEvent) => {
          const bytes = (ev.data as { type?: string; bytes?: ArrayBuffer })?.bytes;
          if (bytes && typeof bytes.byteLength === 'number' && (ev.data as { type: string }).type === 'data') {
            w.__maxPiece = Math.max(w.__maxPiece, bytes.byteLength);
            w.__pieces++;
          }
        });
      }
    };
  });
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await addExactLoop(page, 2.25, 4.25);
  await setRepeats(page, 600);
  // 30 s + 599 x 2 s = 1228 s = 20:28
  const expectedSeconds = 30 + 599 * 2;
  await expect(page.getByTestId('length-extended')).toHaveText('20:28');
  await expect(page.getByTestId('length-note')).toContainText('long file');

  // sample the heap of the page and of the render worker while it exports
  const heaps: { main: number; worker: number }[] = [];
  let sampling = true;
  const heapOf = async (target: Page | Worker): Promise<number> =>
    target.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0).catch(() => 0);
  const sampler = (async () => {
    while (sampling) {
      const worker = page.workers().find((w) => w.url().includes('render.worker'));
      heaps.push({ main: await heapOf(page), worker: worker ? await heapOf(worker) : 0 });
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  await page.getByTestId('export').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  const started = Date.now();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 200_000 }), page.getByTestId('export-confirm').click()]);
  const path = await download.path();
  const took = (Date.now() - started) / 1000;
  sampling = false;
  await sampler;

  const h = readHeader(path);
  process.stdout.write(`20 minute export: ${expectedSeconds} s, ${(h.fileBytes / 1e6).toFixed(0)} MB in ${took.toFixed(1)} s\n`);
  expect(h.format).toBe(1);
  expect(h.channels).toBe(2);
  expect(h.bits).toBe(16);
  expect(h.sampleRate).toBe(44100);
  // header, bytes on disk and the timeline all agree, to the frame
  expect(h.dataBytes).toBe(expectedSeconds * 44100 * 4);
  expect(h.riffSize).toBe(h.fileBytes - 8);
  expect(h.dataBytes).toBe(h.fileBytes - 44);
  expect(h.seconds).toBeCloseTo(expectedSeconds, 6);

  // memory: the song is 211 MB as 16-bit (420 MB as float); no piece and no heap was anywhere near that
  const maxPiece = await page.evaluate(() => (window as unknown as { __maxPiece: number }).__maxPiece);
  const pieces = await page.evaluate(() => (window as unknown as { __pieces: number }).__pieces);
  expect(pieces).toBeGreaterThan(100);
  expect(maxPiece).toBeLessThanOrEqual(Math.round(10 * 44100) * 4 + 4);
  expect(maxPiece).toBeLessThan(h.fileBytes / 50);
  const withHeap = heaps.filter((x) => x.main > 0);
  if (withHeap.length > 0) {
    const peakMain = Math.max(...withHeap.map((x) => x.main)) / 1e6;
    const peakWorker = Math.max(...heaps.map((x) => x.worker)) / 1e6;
    process.stdout.write(`peak JS heap during the export: page ${peakMain.toFixed(0)} MB, render worker ${peakWorker.toFixed(0)} MB (file ${(h.fileBytes / 1e6).toFixed(0)} MB)\n`);
    expect(peakMain).toBeLessThan(250);
    expect(peakWorker).toBeLessThan(250);
  }
  expect(errors).toEqual([]);
});

test('Cancel stops the export, throws the pieces away, and the next export works', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await addExactLoop(page, 2.25, 4.25);
  await setRepeats(page, 4000); // 8,000 s of audio: far more than a few seconds of work
  let downloads = 0;
  page.on('download', () => downloads++);

  await page.getByTestId('export').click();
  await page.getByTestId('export-confirm').click();
  // progress with elapsed and remaining time
  const progress = page.getByTestId('export-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/\d+% · \d+:\d\d elapsed/);
  await expect(progress).toContainText(/about \d+:\d\d left/, { timeout: 60_000 });
  // Cancel is the button that is live while it runs
  const cancel = page.getByTestId('export-cancel');
  await expect(cancel).toBeEnabled();
  await expect(cancel).toHaveText('Cancel export');
  await cancel.click();
  await expect(page.getByTestId('export-status')).toHaveText('Export cancelled. Nothing was saved.');
  await expect(page.getByTestId('export-confirm')).toBeEnabled();
  await expect(cancel).toHaveText('Cancel');
  expect(downloads).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { songLooper: { renderClient: { exporting: boolean } } }).songLooper.renderClient.exporting)).toBe(false);

  // close the dialog, make the plan small and export again: a fresh worker has the song
  await cancel.click();
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  await setRepeats(page, 3);
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-confirm').click()]);
  const h = readHeader(await download.path());
  expect(h.seconds).toBeCloseTo(30 + 2 * 2, 6);
  expect(h.dataBytes).toBe(h.fileBytes - 44);
  expect(errors).toEqual([]);
});

test('over the WAV size limit: a clear message, Export disabled, the repeat count still accepted; target length stops at the cap', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await clickTrackFixture(120, 30);
  await loadFixture(page, fixture);
  await waitForAnalysis(page);
  await addExactLoop(page, 5.25, 15.25); // 10 s

  // 9,999 repeats are accepted; 10,000 are not
  await setRepeats(page, 9999);
  expect(await appState<number>(page, 's.regions[0].repeats')).toBe(9999);
  const repeats = page.getByTestId('repeats').first();
  await repeats.fill('10000');
  await repeats.press('Enter');
  await expect(repeats).toHaveAttribute('aria-invalid', 'true');
  await repeats.press('Escape');

  // 3,000 x 10 s is 8:20:20, over the 6:45:47 that fits at 16-bit stereo 44.1 kHz
  await setRepeats(page, 3000);
  const note = page.getByTestId('length-note');
  await expect(note).toHaveText('Too long for a WAV at 16-bit (max 6:45:47). Lower the repeats.');
  await expect(page.getByTestId('length-extended')).toHaveText('8:20:20');
  const exportBtn = page.getByTestId('export');
  await expect(exportBtn).toBeDisabled();
  await expect(exportBtn).toHaveAttribute('title', /Too long for a WAV at 16-bit \(max 6:45:47\)/);
  await expect(repeats).toHaveValue('3000');

  // 2,000 x 10 s is 5:33:50: fits at 16-bit, not at 24-bit (max 4:30:31) or 32-bit (max 3:22:53)
  await setRepeats(page, 2000);
  await expect(exportBtn).toBeEnabled();
  await expect(note).not.toContainText('Too long');
  await exportBtn.click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('export-problem')).toBeHidden();
  await page.getByTestId('depth-24').check();
  await expect(page.getByTestId('export-problem')).toHaveText('Too long for a WAV at 24-bit (max 4:30:31). Lower the repeats or choose 16-bit.');
  await expect(page.getByTestId('export-confirm')).toBeDisabled();
  await expect(page.locator('label', { has: page.getByTestId('depth-24') })).toContainText('too long');
  await expect(page.locator('label', { has: page.getByTestId('depth-16') })).not.toContainText('too long');
  await page.getByTestId('depth-32').check();
  await expect(page.getByTestId('export-problem')).toContainText('at 32-bit (max 3:22:53)');
  await page.getByTestId('depth-16').check();
  await expect(page.getByTestId('export-problem')).toBeHidden();
  await expect(page.getByTestId('export-confirm')).toBeEnabled();
  // the depth chosen last is remembered, and the length panel says whether the song fits at it
  await page.getByTestId('depth-24').check();
  await page.getByTestId('export-cancel').click();
  await expect(note).toHaveText('Too long for a WAV at 24-bit (max 4:30:31). Lower the repeats or choose 16-bit.');
  await expect(exportBtn).toBeEnabled();
  await page.getByTestId('export').click();
  await page.getByTestId('depth-16').check();
  await page.getByTestId('export-cancel').click();
  await expect(note).not.toContainText('Too long');

  // target length: typed up to the cap (6:45:47), refused above it
  await page.getByTestId('length-mode-target').check();
  const target = page.getByTestId('target-input');
  await target.fill('6:45:47');
  await target.press('Enter');
  await expect(target).not.toHaveAttribute('aria-invalid', 'true');
  await expect(note).toContainText('Closest whole repeats');
  await expect(exportBtn).toBeEnabled();
  const [r] = await appState<{ repeats: number }[]>(page, 's.regions');
  // closest whole repeats that still fit in a WAV: never past 6:45:47, and within a loop of the target
  const total = 30 + (r!.repeats - 1) * 10;
  expect(total).toBeLessThanOrEqual(24347.88);
  expect(24347 - total).toBeLessThanOrEqual(10);
  await target.fill('6:45:48');
  await target.press('Enter');
  await expect(target).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#target-length-msg')).toContainText('max 6:45:47');
  expect(errors).toEqual([]);
});
