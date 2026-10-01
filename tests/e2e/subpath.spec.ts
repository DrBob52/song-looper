import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { appState, makeFixture, waitForAnalysis } from './helpers';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Serve the built site from a sub-path, the way GitHub Pages serves a project site (/<repo>/). */
function serveUnder(prefix: string): Promise<{ server: Server; origin: string }> {
  const root = resolve('dist');
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404).end('not found (outside the project path)');
        return;
      }
      let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
      if (rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(root, rel));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('the built site works from a GitHub Pages style sub-path (workers and worklet included)', async ({ page }) => {
  const prefix = '/song-looper/';
  const { server, origin } = await serveUnder(prefix);
  try {
    const failed: string[] = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const fixture = await makeFixture({ structure: 'ABAB', barsPerSection: 4 });
    await page.goto(`${origin}${prefix}`);
    await page.setInputFiles('[data-testid=file-input]', {
      name: fixture.name,
      mimeType: fixture.mimeType,
      buffer: fixture.buffer,
    });
    await page.waitForSelector('[data-testid=song-panel]:not([hidden])');
    await waitForAnalysis(page); // needs the analysis worker
    expect(await appState<number>(page, 's.analysis.beats.length')).toBeGreaterThan(20);
    // a loop gets its seam report and smoothing plan from the same worker, and the render worker plays the plan
    await page.evaluate(() =>
      (window as unknown as { songLooper: { addLoop(s: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: 0, end: 8 }),
    );
    await expect(page.getByTestId('seam-chip').first()).toBeVisible();
    await expect(page.getByTestId('seam-summary').first()).toBeVisible();
    expect(await appState<boolean>(page, '!!s.regions[0].seam')).toBe(true);
    // the render worker and the SoundTouch worklet load from relative URLs too
    await page.getByTestId('speed').fill('1.2');
    await page.getByTestId('mode-extended').click();
    await expect(page.getByTestId('render-status')).toHaveText('');
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveText('Pause');
    await page.waitForTimeout(500);
    await page.getByTestId('play').click();
    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    server.close();
  }
});
