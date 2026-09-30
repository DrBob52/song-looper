import { defineConfig } from '@playwright/test';

// Playwright is pinned to 1.56.x so that its expected Chromium revision (1194)
// matches the browser pre-installed under PLAYWRIGHT_BROWSERS_PATH. If you run
// with a different browser, set CHROMIUM_PATH to its executable.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const PORT = 4174;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    launchOptions: {
      executablePath,
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
