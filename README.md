# Song Looper

Drop in a song, find sections that loop cleanly, repeat them, and export an extended WAV.
Everything runs in the browser. No server, no uploads.

Work in progress: see `SPEC.md` for the design and milestones.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck and build the static site into `dist/` |
| `npm run preview` | Serve the built site |
| `npm run lint` | ESLint (flat config) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Vitest unit tests |
| `npm run test:e2e` | Playwright smoke tests (builds and serves the site first) |
