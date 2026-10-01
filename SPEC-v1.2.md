# Song Looper v1.2: Exact Control, Long Songs, Vinyl Redesign

Builds on SPEC.md and SPEC-seams.md and the code on this branch. Two parts, in order:

- **Part 1: function.** Exact loop times, much higher repeat counts with exports up to the WAV size limit, an obvious play/pause, and typed input for every adjustable number.
- **Part 2: redesign.** A "vinyl and analog" look for the whole app.

Finish and commit Part 1 before starting Part 2, so a design problem can never block the features.

The user's decisions:

- Repeats go much higher. The extended song may be as long as a WAV file allows.
- Typing exact loop times turns **Smooth seam off** for that loop, so it plays exactly as typed. The user can switch it back on.
- The visual direction is **vinyl and analog**: warm paper, ink black, label red, a spinning record as the play/pause button, and loop cards styled like record labels.

---

# Part 1: Function

## 1. Exact loop times

Each loop row gets editable fields:

```
Start [1:09.600]  [−beat][−10ms][+10ms][+beat]  [Set from playhead]
End   [1:23.600]  [−beat][−10ms][+10ms][+beat]  [Set from playhead]
Length 14.000 s · 8 bars
```

- **Time format.** Accept `m:ss.mmm`, `m:ss`, `ss.mmm`, `h:mm:ss.mmm`, and a plain number of seconds. Display to milliseconds.
- **Commit and cancel.** Enter or blur commits. Escape reverts. An invalid value gets an inline message and keeps the old value.
  - End at or before start: "End must be after start (1:09.600)."
  - Overlapping another loop: "Overlaps Loop 2 (1:20.000–1:30.000)." Refuse it and don't clamp, because the user asked for exact times.
  - Past the song's end, or shorter than the existing minimum loop length: refuse it.
- **Typed and nudged values are exact.** They are never snapped. "Snap to bars" applies only to dragging.
- **Typing turns smoothing off.** Typing a time, nudging, or Set from playhead turns that loop's **Smooth seam** off. Show a one-line notice in the row: "Smooth seam is off so the loop plays exactly these times. Turn it back on to let it move the join." The waveform region updates immediately.
- **Nudges.** "beat" means the analysed beat length at that point. Hide the beat nudges when there is no steady beat.
- **Set from playhead and shortcuts.** Set from playhead uses the current playback position of the original song. Shortcuts: **I** sets the start and **O** sets the end of the selected loop. With no loop selected, I and O set the edges of the waveform selection, and **L** then adds it as a loop. List the keys in the hint text.
- **Add loop** (the existing button) opens a new loop at the playhead with a default length of 4 bars, or 8 s when there are no bars.

## 2. Repeats and long songs

### 2.1 Limits

- **Repeat count:** 1 to 9,999, typed or stepped. The stepper keeps − and +, and holding a button accelerates.
- **Size cap:** the extended length is capped by the WAV size limit for the chosen bit depth and the song's channel count and sample rate:
  - `maxFrames = floor((4_294_967_295 − 1024 − 44) / (channels · bytesPerSample))`
  - About 6.7 h at 16-bit stereo 44.1 kHz.
  - The 1024-byte margin keeps the zip wrapper used inside claude.ai artifacts within 32-bit offsets.
- **Remove the old 60-minute cap** (`RENDER_CONFIG.maxExtendedSeconds`).
- **Over the cap:**
  - The length panel shows: "Too long for a WAV at 16-bit (max 6:45:47). Lower the repeats or choose 16-bit."
  - Export is disabled with that reason.
  - The repeat input still accepts the number, so the user can see why.
- **Target-length mode** accepts targets up to the cap, typed as `h:mm:ss` or `m:ss`.

### 2.2 Export written piece by piece

Rendering a multi-hour song into memory is impossible, since 6 h of stereo float is about 7.6 GB. Replace the export path:

- **`renderRange(plan, outStart, outLength)`.** Renders frames `[outStart, outStart + outLength)` of the extended song. It must produce bit-identical results to slicing the old full render: same crossfades, seam plans, level ramps and bridges. Put a unit test on that equivalence, using random ranges that straddle seams, bridges and edges.
- **Export.** Loop over chunks of about 10 s in the render worker. Optionally pass each chunk through offline SoundTouch, keeping the stretcher's state across chunks and flushing at the end. Encode the chunk to WAV bytes and post it to the main thread.
  - Assemble the output as `new Blob([header, ...chunks])`. Blobs made of many parts let the browser keep them on disk.
  - Never hold the whole song as one `Float32Array`.
- **Progress and cancel.** Progress shows elapsed and remaining time. Add a **Cancel** button that stops the worker and discards the parts.
- **WAV header.** Data size is written once the length is known. Compute it up front from `extendedFrames`, or the stretched length when speed is baked in.
- **Artifact save.** It must still go through `src/audio/save.ts`. The zip path already avoids copying the WAV. Check it works for a part-built Blob and for sizes near the cap (unit-test the header math with a fake size).

### 2.3 Live preview

The extended preview no longer renders the whole song.

- **Playback.** Schedule consecutive chunks of about 5 s from `renderRange` (computed in the render worker) as back-to-back `AudioBufferSourceNode`s on the same context, at exact times. Keep 2 to 3 chunks queued ahead.
- **Seeking.** Restarts the queue from the chunk containing the target.
- **Speed and pitch.** They keep working through the existing SoundTouch worklet: all chunk sources feed the same node. When playback rate changes, rebuild the queue from the current position.
- **Gaps.** None at chunk joins. A test compares the samples captured from an `OfflineAudioContext` that runs the scheduler with `renderRange` over the same span.
- **The extended timeline strip** keeps working for any length, and the time readout handles hours.
- **Seam audition and loop preview** keep their current behaviour.

## 3. Obvious play and pause

- A **large circular play/pause button** in the sticky transport bar, at least 64 px on desktop and 56 px on phones. It reads ▶ or ❚❚ plus the word Play or Pause next to it. `aria-pressed` reflects the state. In Part 2 this becomes the record.
- **Space** still toggles it.
- **Each loop row** gets a play button that plays that loop on repeat, replacing the text button "Loop".

## 4. Type any number

Build one reusable field component, `NumberField`, and use it for **every** adjustable number. Pair it with the slider or stepper where one exists, and keep both in sync.

| Control | Type-in format | Range / step |
|---|---|---|
| Loop start / end | time, ms precision | within the song |
| Repeats | integer | 1–9,999 |
| Target length | `h:mm:ss` or `m:ss` | up to the WAV cap |
| Speed | `1.00` (`x` optional) | 0.50–1.50, step 0.01 |
| Pitch | semitones, decimals allowed (`-1.5`) | −12 to +12, step 0.1 |
| Tempo (BPM) | `120.0` | 30–300; overrides the detected tempo like the half/double menu does today |
| Bar-line shift | integer beats | 0 to beatsPerBar−1 |
| Zoom | px per second | the zoom slider's range |
| Seam fade (advanced) | ms | the existing range |

`NumberField` behaviour:

- Up and Down arrows step the value. Shift multiplies the step by 10, and Alt divides it by 10.
- Enter or blur commits. Escape reverts.
- An invalid value shows a red outline and a short message, and is never committed.
- Mouse-wheel scrolling never changes the value by accident.
- It has a visible focus state and a stable `id`.
- `data-testid`s stay as they are where they exist, and new ones are added.

## 5. Part 1 tests

**Unit:**

- The time parser handles every format, rejects junk, and round-trips the display format.
- `renderRange` equals a slice of the full render, as in 2.2.
- WAV cap math is right for 16-bit, 24-bit, 32-bit float, mono and stereo.
- The zip header math is right near the cap.
- Repeat limits and target-length validation work at the cap.

**E2E:**

- Type a start and end and the region moves; Smooth seam turns off; the overlap error appears.
- Nudge buttons move the edge by exactly 10 ms. Set from playhead and the I and O keys work.
- Repeats 500 on a short fixture: the length panel is correct, and preview plays and seeks with no errors.
- Export of a long plan (about 20 min at 16-bit, with a test-only mode to speed it up if needed): the WAV header duration matches the timeline, and memory doesn't blow up (no single allocation the size of the song).
- Export Cancel works.
- Typing speed, pitch and BPM works, with the slider in sync.
- Every existing test still passes. Update selectors only where the markup has to change, and never weaken an assertion.

---

# Part 2: Vinyl and Analog Redesign

Restyle the **whole app**. Keep every feature, `data-testid`, keyboard shortcut and behaviour.

## 6. Direction

A record shop and a listening room. The song is a record. The app presses an extended cut of it.

- **Light:** warm paper sleeves and ink.
- **Dark:** the same shop after closing, with dark wood and warm lamp light.
- **Subject details to use as real UI, not decoration:**
  - tracklist numbering for suggestions (A1, A2, ...)
  - label cards for loops
  - rubber-stamp seam chips
  - a record whose spin speed follows the playback speed (33⅓ rpm at 1.00×)
  - matrix-number style monospace for every time readout.

## 7. Tokens (put these at the top of style.css, replacing the current palette)

```css
/* Layout: one centered column like a record sleeve, sticky turntable bar at the bottom. */
:root {
  --paper: #efe6d6;        /* page */
  --sleeve: #f8f2e7;       /* cards, panels */
  --ink: #1d1915;          /* text, waveform */
  --ink-soft: #6b6157;     /* secondary text */
  --rule: #d8ccb8;         /* hairlines */
  --label-red: #c6372c;    /* primary accent: play, export, selected */
  --mustard: #d6a03d;      /* secondary accent: highlights, section stickers */
  --vinyl: #121110;        /* the record */
  --ok: #2f7a4f; --warn: #b8741a; --bad: #b3261e;   /* stamps */
  --loop-1: #c6372c; --loop-2: #2e5aa8; --loop-3: #d6a03d; --loop-4: #2f7f79; --loop-5: #7a3e6e;
  --font-display: 'Archivo', 'Arial Narrow', system-ui, sans-serif;  /* width axis: 62–125 */
  --font-body: 'Archivo', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
}
/* dark: same token names, listening-room values */
/* --paper #17130f, --sleeve #221c16, --ink #efe4d3, --ink-soft #a8998a, --rule #3a3027,
   --label-red #e0574a, --mustard #e3b25a, --vinyl #0b0a09, stamps lightened for contrast */
```

- **Theme selectors.** Keep the existing selector structure: `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme='light'])`, plus `:root[data-theme='dark']` and `:root[data-theme='light']`. claude.ai sets `data-theme`.
- **Fonts.** Load Google Fonts with a `<link>` in `index.html`:
  - Archivo, variable over width 62–125 and weight 400–800
  - IBM Plex Mono 400 and 600, with `display=swap`
  - Google Fonts is the only external host the artifact allows, so load nothing else externally. Note in the final report that the artifact page needs the same `<link>`.
- **Paper grain.** A subtle grain on `--paper` from an inline SVG `feTurbulence` data URI, at or below 4% opacity. No image files.
- **The waveform** reads its colours from these tokens. Update `refreshTheme`.

## 8. Components

- **Masthead.** "SONG LOOPER" set in Archivo at width 125, weight 800, tight tracking. Under it, one line in small caps: "Drop in a record. Press an extended cut." Keep it compact, never a 100vh hero.
- **Drop zone.** A record sleeve: a square card with a record peeking out of the top edge, drawn in CSS, and the text "Drop a song here or click to choose". After loading, it compacts into a sleeve strip with the file name, duration, sample rate and channels in mono.
- **Turntable bar** (sticky bottom, respecting the safe area):
  - **The record is the play/pause button.** It's a CSS-drawn vinyl, about 72 px desktop and 60 px phone: `--vinyl` base, `repeating-radial-gradient` grooves, a soft sheen, and a centre label in `--label-red` showing ▶ or ❚❚.
  - It spins while playing at `1.8 s / speed` per turn (33⅓ rpm × speed). It stops in place, without snapping back, when paused.
  - Next to it, a clear text label "Play" or "Pause". `prefers-reduced-motion`: no spin.
  - **Time readout** in mono: `01:09.600 / 06:45:47.000`.
  - **Original / Extended** as a two-sided switch labelled **A · Original** and **B · Extended**.
  - **Speed and pitch** in a fold-out with sliders and number fields.
  - **Export WAV** as the strongest button, a solid `--label-red` pill.
- **Waveform panel.** Ink waveform on sleeve paper. Beat lines are hairlines and bar lines darker. Section markers become small mustard stickers with letters. Loop regions are translucent loop colours with a 2 px top band in the solid colour. The playhead is a thin red needle line with a small round head.
- **Suggestions = tracklist.**
  - Each row reads `A1  0:06.000 – 0:22.000   8 bars · 16.0 s   ★★★★★`, numbered A1, A2 ... in rank order.
  - The reason goes on the next line in `--ink-soft`.
  - Actions are on the right as quiet text buttons, with Add as the one solid button.
  - Show all 12 → "Show the whole side".
- **Loops = label cards.**
  - Left: a circular label (56 px) in the loop's colour showing the loop number large and `×repeats` small, like a record centre.
  - Right: the exact-time fields, nudges, repeats, toggles and actions from Part 1, laid out in a clear grid that wraps at phone width.
  - Seam chip = a **rubber stamp**: uppercase CLEAN / OK / ROUGH, a 2 px border in the stamp colour, slight rotation (−2°), a faintly uneven edge drawn with an SVG mask or box-shadow. Text stays readable.
  - The seam summary line and the bridge status sit below in mono.
- **Length panel.** Big mono numbers `3:42 → 6:45:47` with "original → extended cut" in small caps under them. The cap message shows in `--warn` when it applies.
- **Extended timeline strip.** Like a record's run-out groove map. A horizontal bar of segments: original audio in `--rule`, repeats in their loop colour (repeat numbers in mono when they fit), bridges hatched. Rounded ends.
- **Dialogs** (export) look like an inner sleeve: centered card with a paper-grain background. The progress bar shows as a groove filling with red.
- **Buttons.** Three levels only: solid red (primary), outlined ink (secondary), text (tertiary). Every one gets a visible focus ring in `--mustard`. Inputs are underlined fields on paper, or boxed in mono for numbers.

## 9. Motion (one orchestrated moment, little else)

- The record spin (above).
- On Play from stopped: a **needle drop**. The record's label scales 0.96 → 1 over 150 ms while the spin eases in over 400 ms.
- Hover on cards: a 1 px lift with the shadow deepening. No other animation.
- Everything respects `prefers-reduced-motion`.

## 10. Quality bar

- **Phone width.** Works at 380 px with a 16 px side gutter and no horizontal page scroll. The turntable bar stays usable: record, time, Play label and Export, with speed and pitch folded away.
- **Contrast.** Text meets WCAG AA in both themes. Test the stamps and loop colours on both papers.
- **Unchanged behaviour.** No feature, shortcut or `data-testid` lost. The whole test suite still passes.
- **Screenshots.** Update `docs/screenshot.png` (light) and add `docs/screenshot-dark.png`, both showing a loaded song, suggestions, two loop cards (one with a bridge), and the turntable bar.
- **Fonts.** Show the Google Fonts load with fallbacks working when blocked: test once with the fonts route aborted in Playwright and check nothing breaks.

## 11. Milestones (commit and push after each)

1. Time parsing, `NumberField`, exact loop times with nudges, Set from playhead and I/O; Smooth seam turns off on typed edits.
2. Every numeric control uses `NumberField`; the large play/pause; per-loop play button.
3. `renderRange` plus the piece-by-piece export with progress and Cancel; WAV cap; repeats up to 9,999; target length up to the cap.
4. Live chunked preview with seek and speed/pitch; remove the 60-minute cap.
5. Redesign: tokens, fonts, grain, masthead, drop zone, turntable bar with the record.
6. Redesign: waveform, tracklist, label cards, stamps, length panel, timeline strip, dialogs, phone layout, dark theme.
7. Screenshots, README updates (new controls, limits, design notes), final full test run.
