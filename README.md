# Song Looper

Drop in a song. The app finds sections that loop cleanly, you pick one or more of them, say how many times
each should repeat, preview the result, and export an extended version of the song as a WAV.

Everything runs in the browser. There is no server, no API key and nothing is uploaded.

![Song Looper screenshot, light](docs/screenshot.png)

*A synthetic chord-progression demo. Loop 1 has a bridge, so its seam reads Clean and the extended timeline shows
the hatched bridge bars. Loop 2 ends one bar early on a chord change the song never makes: Rough, with a cleaner
loop suggested nearby.*

| Dark | Phone (380 px) | Phone, dark |
|---|---|---|
| ![Dark theme](docs/screenshot-dark.png) | ![Phone layout](docs/screenshot-phone.png) | ![Phone layout, dark](docs/screenshot-phone-dark.png) |

The look is "vinyl and analog": a warm paper page, a spinning record as the play/pause button, record-sleeve cards for
the loops and rubber-stamp seam chips. See [Design notes](#design-notes).

## What it does

- Loads mp3, wav, m4a/aac, flac, ogg or anything else your browser's `decodeAudioData` accepts, and keeps the
  file's native sample rate and channel count for rendering and export. When the browser can't decode an m4a or
  .aac file (Chrome and Firefox never decode Apple Lossless, and some Chromium and Linux Firefox builds lack AAC),
  a bundled decoder takes over. It loads only when needed. Copy-protected files (Apple Music downloads) get a
  clear error, since nothing can decode them.
- Analyses the song in a Web Worker: beats, tempo (with a half/double override), bars, sections (A, B, C, ...)
  and a ranked list of loop suggestions, each with a one-line reason.
- Shows the waveform (wavesurfer.js v7 + Regions plugin) with the beat and bar grid and section markers. Drag on
  it to select a span, press `L` to turn the selection into a loop, drag edges to fine-tune (they snap to bars, or
  beats; hold Shift to turn snapping off). Loops cannot overlap.
- Each loop has its own start and end, typed to the millisecond (see [Exact loop times](#exact-loop-times)), and
  its own repeat count (1 to 9,999). Or set a target length and let the app choose repeat counts.
- Previews the original or the extended song, a loop on repeat, or just the seam (the jump from a loop's end back
  to its start) through the same crossfade code the export uses. A big round record button in the sticky bar plays
  and pauses, and each loop row has its own play button.
- Plays and exports extended songs of any length the WAV format can hold, see [Long songs](#long-songs).
- Smooths the seam of every loop so the join sounds like part of the song, and says how it went with a Clean / OK /
  Rough chip. Optionally bridges a rough seam with a few bars of the song. See
  [How seams are smoothed](#how-seams-are-smoothed).
- Speed (0.5x to 1.5x, tempo only) and pitch (-12 to +12 semitones) for preview, optionally baked into the export.
- Exports 16-bit or 24-bit PCM or 32-bit float WAV.

Keyboard: `Space` play/pause, `L` add a loop at the selection (or at the playhead), `I` / `O` set the start / end of
the selected loop (or of a new one) to the playhead, `Delete` remove the selected loop, `Esc` clear the selection.
In a number field: `Up` / `Down` step (`Shift` for 10 times as much, `Alt` for a tenth), `Enter` or leaving the field
applies, `Esc` puts the old value back. The mouse wheel never changes a number.

### Exact loop times

Every loop row has **Start** and **End** fields. Type a time as `75`, `75.25`, `1:15.250` or `1:02:03.5`, press
`Enter`, and the loop edge goes there, to the millisecond. Next to each field are `-1 beat`, `-10 ms`, `+10 ms` and
`+1 beat` nudges, and **Set from playhead** (the `I` and `O` keys do the same for the selected loop). A bad value
(past the end of the song, an end before the start, a loop shorter than 100 ms, or one that would overlap another
loop) is refused with a message under the field and the old value stays.

Typed and nudged times are used as they are: they are never snapped to bars or beats (snapping applies only to
dragging an edge on the waveform). Because smoothing would move the edge, the loop's **Smooth seam** is switched off
when you type, nudge or set from the playhead, and a notice says so. Turning it back on lets the app move the join
again. As in every version, the renderer still moves a loop edge by at most 2 ms to the nearest zero crossing so the
join doesn't click; the fields and the timeline show the time you gave.

### Numbers

Every adjustable number (loop start and end, repeats, target length, speed, pitch, BPM override, bar-line shift,
waveform zoom and the seam fade) is the same field: type it, step it with the arrow keys, or use its slider or
`-`/`+` buttons, which stay in step with it. Holding a stepper button speeds up after a moment.

### Long songs

- **Repeats** go up to 9,999 per loop. There is no time limit on the extended song. The only limit is the WAV file
  itself: sizes are 32-bit, so a file is under 4 GB. The length panel shows the longest extended song for the chosen
  bit depth (for a 44.1 kHz stereo song about 6 h 45 min at 16-bit, 4 h 30 min at 24-bit and 3 h 22 min at 32-bit
  float), and a plan that goes over says so, with Export disabled until you change the repeats, the target or the
  bit depth. The target-length solver never goes over it.
- **Export** renders the song in pieces of about 10 s (`renderRange`), writes each piece into the file as it is made,
  and never holds the whole song in memory. It shows progress with the elapsed and remaining time and has a **Cancel**
  button that stops the work and frees what was written. The pieces are bit-identical to the same stretch of one big
  render. Inside a claude.ai artifact the file is zipped for saving, and the zip is also kept under 4 GB.
- **Preview** of the extended song plays in 5 s chunks that are started back to back (three ahead), through the same
  renderer and the same speed/pitch node, so a very long song starts quickly, seeks anywhere and changes speed and
  pitch while playing, with no gap or click at the joins.

## Run it locally

Needs Node 20.19 or newer (22 is what CI uses).

```sh
npm install
npm run dev          # http://localhost:5173
```

No music handy? Generate a synthetic demo song (chord loops A B A B C A over a kick) and drop it in:

```sh
npm run demo-song    # writes tests/fixtures/demo-song.generated.wav (git-ignored)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then build the static site into `dist/` |
| `npm run preview` | Serve the built site |
| `npm run lint` | ESLint (flat config) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Vitest unit tests |
| `npm run test:e2e` | Playwright end-to-end tests (builds and serves the site first) |
| `npm run demo-song` | Write a synthetic demo song WAV |
| `BIG_EXPORT_SECONDS=14400 npx playwright test big-export` | Opt-in: export a very long extended song through the real UI and check the WAV header against the file on disk (`BIG_EXPORT_BITS=16\|24\|32`, `BIG_EXPORT_ARTIFACT=1` to save it zipped as a claude.ai artifact would) |
| `SCREENSHOT=1 npx playwright test screenshot` | Regenerate the four screenshots in `docs/` |

## Tests

- **Unit (Vitest)** run against audio that the tests synthesise (`tests/fixtures/synth.ts`): click tracks at
  100/120/140 BPM (tempo within +-1 BPM, beats within 30 ms), a synthetic A B A B C A song (the top candidate must
  start and end on the A/B boundaries and an A or A+B loop must be in the top 3), other structures and tempos, 3/4,
  the timeline and render maths, seam crossfade continuity, zero-crossing snapping, the target-length solver, the
  WAV encoder, sample-rate sniffing and the offline SoundTouch stretch. The seam work is tested on songs built
  from named chord progressions (one chord per bar over a kick, also in `synth.ts`): the harmony of the same loop
  with and without the chord change in the song, suggestions, rotation (length unchanged, never more than a beat,
  lands before a hit), micro-alignment (a +15 ms edge recovered within 2 ms, one onset in the seam window), the fade
  limit at poor harmony, the level step after a 3 dB crescendo, bridge search, render length and target solver, Undo,
  and how stale seam data is dropped when the tempo, meter or bar lines change. The long-song work has its own
  tests: `renderRange` equals the same stretch of a reference full render bit for bit (plain loops, seam plans with
  bridges, level ramps and fades longer than the piece, loops at the song's edges, mono and three channels; ranges
  around every jump, random short and long ranges, and consecutive pieces joined), the export pieces equal one
  full render (also with speed and pitch baked in), the WAV encoder and zip layout at the 4 GB edges (without
  allocating the file), the number parser and formatter, and the chunk scheduler of the live preview against a fake
  audio context (each chunk starts when the last ends, three queued ahead, seek, speed, late renders). The design
  tokens have a WCAG contrast test (4.5:1 for text, 3:1 for stamp borders, both papers, both themes) and a check that
  the two dark blocks in `style.css` say the same thing.
- **End to end (Playwright, Chromium)**: load a generated WAV, select a span, add a loop, repeat it, export,
  and check the downloaded WAV's header and duration (and decode it with `decodeAudioData`); suggestions, preview,
  seam audition, snapping, target-length mode, the timeline strip, live speed/pitch (through the real AudioWorklet),
  baked export, the seam chip, Undo, nearby loops, bridges (chip, hatched strip, export length), error and edge
  cases, a 380 px layout check in light and dark mode, saving as a claude.ai artifact, and serving the built site
  from a GitHub Pages style sub-path. v1.2 added: typed and nudged loop times, `I`/`O` keys and the Smooth seam
  notice; every number field (typing, steppers, slider sync, bad values); a long export that is checked piece by
  piece and cancelled part way; the live preview (plays and seeks at 500 repeats, changes speed and pitch while it
  plays, and the scheduler run on an `OfflineAudioContext` must give the samples of `renderRange` over the same span:
  identical at the song's own sample rate, no tick at any join at 48 kHz and 32 kHz); and the design (the record spins at 1.8 s / speed and stops at the same angle, reduced motion, no horizontal scroll
  at 380 px, nothing sticking out of its card, both themes, fonts blocked).

Playwright is pinned to 1.56.x so that its Chromium revision matches the browser pre-installed in this
environment under `PLAYWRIGHT_BROWSERS_PATH`. To use another browser, set `CHROMIUM_PATH` to its executable.

The e2e tests stub the Google Fonts stylesheet (`tests/e2e/fixtures.ts`), so they never depend on the network and the
app falls back to its system fonts there. `SCREENSHOT=1 npx playwright test screenshot` regenerates the four images in
`docs/` (light, dark, phone, phone dark). To get the real fonts in them when the machine can't reach Google Fonts,
download the stylesheet and the font files once (for a Chrome user agent) into a folder and set `FONTS_DIR` to it;
`tests/e2e/screenshot.spec.ts` explains the steps.

`big-export` writes a real file of up to 4 GB, so it is opt-in. It uses a persistent browser profile because
Chromium's default test contexts keep blobs in memory only and cannot hold more than about 2 GiB.

## Deploy (GitHub Pages)

`vite.config.ts` uses `base: './'`, so every asset URL is relative and the same build works at
`https://<user>.github.io/<repo>/` (and is tested from a sub-path).

`.github/workflows/deploy.yml` runs lint, typecheck, unit tests and the build on every push to `main`, then
publishes `dist/` with the official `actions/configure-pages`, `actions/upload-pages-artifact` and
`actions/deploy-pages`. One-time setup: in the repository settings, set **Pages > Source** to **GitHub Actions**.
The workflow can also be run by hand from the Actions tab.

### Running as a claude.ai artifact

The same build also runs as a claude.ai artifact. A page there can't start downloads itself, so
`src/audio/save.ts` asks the host through `claude.use("downloads")`. That save dialog accepts `.zip` but not
`.wav`, so inside an artifact the export arrives as a zip holding the WAV (a loop with seam smoothing and a bridge
included). Everywhere else it's a plain WAV download. The build is one `index.html` plus files under `assets/`, all
referenced by relative URLs (`base: './'`): the analysis worker (which also does the seam work), the render worker,
the SoundTouch worklet and the lazily loaded AAC decoder. The seam features added no extra files or dependencies.

## How loop suggestions work

All of this is plain TypeScript in `src/analysis/` (pure functions, no Essentia, no WASM) and every weight and
threshold lives in `src/analysis/config.ts`.

1. **Mono, 22.05 kHz** audio goes to a worker. An STFT (Hann 2048, hop 512) is computed once, in a single pass
   that also extracts per-frame chroma, log-mel and low-frequency energy.
2. **Onset strength**: log-compressed spectral flux, minus a 0.5 s local mean, clipped and normalised.
3. **Tempo**: autocorrelation of the (mean-removed) onset envelope over 60 to 200 BPM, weighted by a log-normal
   prior around 120 BPM. The runner-up tempo is kept for the half/double override.
4. **Beats**: Ellis dynamic-programming tracker (as in `librosa.beat.beat_track`). Because the coarse frames make
   onsets peak early, each beat is then refined on a fine-resolution onset curve; if kick-drum onsets are clearly
   stronger half a beat away, the beats move there (this stops the tracker locking onto off-beat hi-hats).
5. **Bars**: the bar phase with the strongest onset + bass energy on its downbeats. You can switch to 3/4 or 6/8
   and nudge the bar line by a beat; only this stage and the ones after it re-run.
6. **Features per beat**: chroma (12, L2-normalised), timbre (MFCC 1 to 13, z-scored) and loudness, weighted
   `[chroma * 1.0, timbre * 0.6]`.
7. **Self-similarity**: cosine similarity of the features stacked with the next 4 beats, so it compares short
   phrases.
8. **Sections**: a Gaussian-tapered checkerboard kernel slid along the diagonal (at two scales, combined with a
   geometric mean), prominent peaks snapped to bar lines, then agglomerative clustering labels them A, B, C in
   order of first appearance. The label that repeats most gets a cautious "likely chorus" hint.
9. **Candidates**: every bar-aligned pair `(a, b)` of 2 to 32 bars (at least 4 s, at most half the song) is scored
   0.5 x seam + 0.25 x structure + 0.15 x energy continuity + 0.10 x length preference. The seam is half
   *context match* and half *harmony*. Context match is the better of two means over four beats: `S[a-1-j][b-1-j]`
   (the lead-ins match) and `S[a+j][b+j]` (the continuations match). Harmony asks whether the song itself makes the
   chord change from the beat before `b` to the beat at `a` (see [How seams are smoothed](#how-seams-are-smoothed)). Overlapping near-duplicates are suppressed
   and the top 12 are kept, each with a reason such as "Seam match 100%, chords lead back cleanly, sections B+A".

### Splicing

`buildTimeline` lays out `[0, r1.start) -> r1 x n -> [r1.end, r2.start) -> ...`; `renderExtended` copies it
sample by sample. Loop edges first snap to the nearest zero crossing (+-2 ms, on the mid channel, both channels
moved together). Each jump from a loop's end back to its start gets an equal-power crossfade (20 ms by default,
"Seam smoothing" under Advanced), which blends toward equal-gain when the two sides are highly correlated, because
a pure equal-power fade of two identical signals would swell by 3 dB. A loop with **Smooth seam** on (the default)
picks its own fade length instead, as described below, and the "Seam smoothing" length applies to loops with it off.
Preview and export use the same renderer, so what you hear is what you get.

### Speed and pitch

Preview runs through `@soundtouchjs/audio-worklet` (an AudioWorklet `SoundTouchNode`; tempo is driven by the
source's `playbackRate` and the worklet compensates pitch). The node is only in the signal path when speed or
pitch is not neutral. Exporting with "Apply speed and pitch changes" ticked processes the rendered channels with
`@soundtouchjs/core` inside the render worker (a WSOLA stretch stage plus the rate transposer), with progress.

## How seams are smoothed

A loop sounds seamless when the end leads back into the start the way the song itself would. A crossfade can't give
you that: it blends two sounds, so when the chords on either side of the seam clash, a longer fade only lets you
hear both chords at once. The app therefore works on **where** the seam is, and uses the fade only for timing and
timbre. Everything is signal processing on data the analysis worker already has. There is no AI model and no
generated audio, and none of it needs a server.

**Does the song make this chord change?** The song shows which chord changes sound natural. Per beat the app has a
12-note chroma vector (which notes are sounding). A jump from beat `x` (the last beat played) to beat `y` (the next
one) is natural if somewhere in the song, two beats that sound like the ones before `x` are followed by two beats
that sound like the ones from `y`. The score is the mean of the two best such places that are at least a bar apart
(a place that matches almost exactly stands on its own, so a chord change the song makes once still counts). The
number is then measured against the song's own random jumps: the median jump scores 0 and the 95th percentile
scores 1, so a song that sits on one chord doesn't make everything look natural. A song with no spread at all
scores every seam 1 and lets the other two scores decide. Take a song that plays C G Am F, Dm Em F G, then both
again, one chord per bar. A loop of the first four bars ends on F and returns to C, F to C never happens in the
song, and the loop scores 0. A loop of all eight bars ends on G and returns to C, G to C happens (where the second
round starts), and it scores 1.

**The Seam chip.** Each loop's seam gets three scores: how well it hides in front of a drum hit, how close the
spectrum across the seam is to the song's own at that point in the bar, and the harmony above. Quality is 0.25 hit
+ 0.25 spectrum + 0.5 harmony, because the chord is what you hear. 70% or more reads **Clean**, 55% or more
**OK**, anything below **Rough**. The tooltip shows the numbers before and after smoothing. Without a steady beat
there is no harmony score and the chip comes from the other two.

**Smooth seam** (a checkbox on each loop, on by default) does four things. The loop's own start and end stay
exactly where you put them; the app only changes how the jump is played, so it can show what it did and **Undo**
is exact.

1. *Rotation.* Both edges shift together by up to a beat either way, so the loop keeps its exact length and the
   groove doesn't change. Quarter-beat positions are tried, the two best are refined in 5 ms steps within 30 ms,
   and each is scored on a hit just after the seam (0.4), spectral continuity (0.4) and harmony (0.2), with a small
   cost for moving. A seam that is already fine stays where it is. The edges never leave the free space around the
   loop.
2. *Micro-alignment.* The end edge alone moves by at most 20 ms, to where the fine onset curves around the two
   edges line up best (the waveform when neither has a hit). This fixes a drum hit that would land twice.
3. *Adaptive fade.* The seam is rendered with 10, 20, 40, 80, 160 ms and one-beat fades, and the shortest one
   whose spectral discontinuity is close to the best wins. When the chord change is not natural (harmony below 0.5)
   only fades of 40 ms or less are allowed.
4. *Level match.* If the last beat and the first beat differ by more than 1.5 dB beyond the song's own accent
   pattern, the last beat of the loop ramps linearly to meet the first. It only applies to repeats that jump back;
   the last pass into the rest of the song is untouched.

The loop row shows a one-line summary such as `Seam moved +61 ms · aligned +7 ms · fade 40 ms`, **Undo** (which
restores the original seam and turns smoothing off for that loop), **Audition seam** (plays the smoothed seam) and
**Hear original** (plays the raw seam for comparison).

**Cleaner chord change nearby.** When a loop's harmony is under 0.5, the app looks for a loop whose start is within
a bar of yours, whose end is within two bars, and that is a whole number of bars long, and picks the one with the
best harmony (the suggestion score breaks ties). It is only offered if it scores at least 0.7 and is clearly better.
The loop row shows it with **Audition** and **Use**. Nothing moves until you click.

**Bridge** (a checkbox on each loop, off by default). When no jump from the loop's end back to its start sounds
natural, the loop can play a few bars of the song after its end and jump back from a place where the song does make
that chord change. The app searches for a path that starts at the loop's last beat and comes back to its first, plays
1 to 4 whole bars beyond the loop and jumps at most twice. A jump has to be one the song makes (harmony 0.5 or more)
and has to land at the same place in the bar as the beat it replaces. The simplest path, carrying on into the song and
jumping back at the bar line where the chord change occurs, is always among the ones considered, and the song's own
continuation wins ties. A bridge is only offered when its weakest jump is at least 0.2 better than the direct seam;
otherwise the row says `No natural bridge found` or `No bridge needed`. Every repeat except the last plays the loop
and then the bridge, every jump in it gets the same smoothing as a plain seam, and the last repeat flows into the rest
of the song as usual. The timeline, the extended length, the target-length solver, the extended timeline strip (bridges
are hatched in the loop's colour), seam audition, loop preview and export all include it.

Seams that read Rough show a "Seam sounds rough? Try Bridge" hint. Stem separation (giving drums, bass and vocals
each their own seam) is not part of this version.

## Design notes

The redesign (SPEC-v1.2.md, sections 6 to 10) is CSS and markup only; no behaviour, `data-testid` or shortcut changed.

- **Tokens.** Every colour, font and radius is a custom property defined first on bare `:root` at the top of
  `src/style.css`. Dark mode redefines them in `@media (prefers-color-scheme: dark)` for
  `:root:not([data-theme='light'])` and again for `:root[data-theme='dark']` (the two blocks are identical, which a
  test checks), so the OS setting is followed unless `data-theme` forces light or dark.
- **Type.** Archivo (variable width 62 to 125 and weight 400 to 800) for headings and body, IBM Plex Mono for every
  time and number, both from Google Fonts, which is the only external host. If the request is blocked the page
  falls back to Arial Narrow and the system fonts and nothing else changes.
- **Record.** The big round play/pause is a record with a red label. Playing turns it once every 1.8 s divided by the
  speed (33 1/3 rpm at 1.00x), pausing stops it where it is, and starting is a short "needle drop" (the label
  settles in 150 ms, the spin eases in over 400 ms). With `prefers-reduced-motion` it doesn't turn, and the other
  animations are off too.
- **Cards and stamps.** Suggestions read as a tracklist (A1, A2, ...), each loop is a sleeve card with a round
  label showing its number and repeats in the loop's colour, and the seam result is a rubber stamp:
  Clean (green), OK (amber), Rough (red), text and border at WCAG AA.
- **Accessibility.** Text is at least 4.5:1 on both papers in both themes (unit-tested), colour is never the only
  carrier (stamps and loops carry words and numbers), focus rings are visible, and the page has no horizontal scroll
  at 380 px.

## Project layout

```
index.html
src/
  main.ts  app.ts  model.ts  plan.ts  grid.ts
  ui/        dropzone, waveform, suggestionsPanel, regionsPanel, lengthPanel, timelineStrip, transport,
             exportDialog, analysisControls, seamText, numberField, holdRepeat, record, loopColors
  audio/     decode (+ sniff), player, render (renderRange), preview, stream, chunkSource, target, stretch,
             wav, zip, exportPieces, blobAssembler, save, renderClient/worker/protocol
  analysis/  stft onset tempo beats bars features ssm sections candidates pipeline config worker client
             harmony seam smooth nearby bridge bridgePlan   (seams, see "How seams are smoothed")
  label/     provider.ts   (LabelProvider interface, no-op default)
tests/       unit/  e2e/  fixtures/
scripts/     make-demo-song.ts
.github/workflows/deploy.yml
```

## Known limits

- Beat and structure analysis is heuristic. Expect octave (half/double) tempo errors on some songs, which the
  tempo menu fixes, and approximate section boundaries on real recordings. Ambient or rubato music gets a
  "No steady beat found" warning and a fixed 0.5 s snapping grid.
- The harmony score comes from the song's own chroma, not from recognising chords, so it only knows chord changes
  that the song itself makes. A song that never repeats a chord change gives every seam a poor score, and a seam in
  a song with no steady beat has no harmony score at all (the chip then rests on the other two scores). Smoothing moves a seam by at most a beat and 20 ms; it
  can't make a bad chord change good (the nearby loop and the bridge are for that, and a bridge only jumps between
  bar positions that match).
- Files over 20 minutes load with a warning. The extended song has no length limit of its own; the WAV format
  does (under 4 GB, so a few hours, depending on bit depth, sample rate and channel count). Inside a claude.ai
  artifact the saved zip has the same limit. Chromium keeps a download that the page builds as a blob; very large
  exports need that much free disk (or, in a private window, memory) in the browser, and a browser that refuses the
  blob ends the export with an error rather than a bad file.
- Typed loop times are exact in the interface; the renderer still moves an edge by at most 2 ms to the nearest zero
  crossing.
- Files with more than two channels are stretched pair by pair when speed or pitch is baked in.
- Optional AI labelling of sections and saving loops between sessions are not in v1 (`src/label/provider.ts` is
  the extension point for the former).

## Licences

No licence has been chosen for this repository's own code yet. Runtime dependencies: `wavesurfer.js` (BSD-3-Clause),
`fft.js` (MIT), `@soundtouchjs/*` (MPL-2.0) and `@audio/decode-aac` (the m4a fallback: its AAC decoder is FAAD2
under **GPL-2.0**, its ALAC decoder Apache-2.0). If you publish this app under a licence that isn't GPL-compatible,
swap that fallback for an LGPL one such as an FFmpeg WASM build. Essentia.js (AGPL) and Rubber Band (GPL, needs COOP/COEP headers that
GitHub Pages cannot set) are deliberately not used.
