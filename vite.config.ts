import { defineConfig } from 'vitest/config';

// `base: './'` makes every asset URL relative, so the built site works from any
// path, including a GitHub Pages project site at https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
