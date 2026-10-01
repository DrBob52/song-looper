# Song Looper v1.3: Layout Fixes, Cuts, Endings, Wide Layout, Themes

Builds on SPEC.md, SPEC-seams.md, SPEC-v1.2.md and the code on this branch. **Seam behaviour stays exactly as it is.** The user decided against reverting it, so don't change Smooth seam, the bridge or the nearby-loop logic.

The user's requests:

1. Fix overlapping UI.
2. Remove parts of the song, marked on the song's waveform.
3. Choose where the extended song ends, and fade out into that point.
4. On wide windows, lay the cards out in two columns of unequal width. The current single-column layout stays for narrow windows only.
5. Add theme options. Vinyl stays the default, and the picker adds Studio hardware, Night club, Clean pro tool and a retro-futurist "Space age" theme.

---

## 1. Fix overlapping UI

The user's screenshot of the empty state shows two problems:

- **The sleeve's ring overlaps text.** The decorative ring on the drop-zone sleeve sits on top of both "SIDE A · 33 1/3 RPM" and the heading "DROP A SONG HERE OR CLICK TO CHOOSE".
  - Fix: lay the sleeve out so the ring, the side label, the heading and the help text each have their own space, stacked or in a grid. Nothing absolutely positioned may sit over text.
  - Check it at 380 px, 768 px, 1100 px and 1600 px, in every theme.
- **The player bar shows before there's a song.** The sticky turntable bar appears with greyed-out controls before any song is loaded.
  - Fix: hide the bar until a song is decoded. When it appears, slide it in over 200 ms, or with no animation under `prefers-reduced-motion`.
  - The page needs bottom padding equal to the bar's height while it is shown, so the bar never covers the last card when you scroll to the bottom.

**Audit the rest of the app** for the same class of bug, loaded and empty, at every width, in every theme. Then add an automated guard:

- **E2E test `layout-overlap.spec.ts`.** For each theme × {empty, loaded with 2 loops, 1 cut and a fade} × {380, 1100, 1600 px} × {light, dark where the theme has both}:
  - collect the bounding boxes of every visible element that directly contains text, plus every button and input;
  - assert that no two of them intersect by more than 1 px, unless one contains the other;
  - assert that none sticks out of its card;
  - at the bottom of the page, assert the turntable bar doesn't cover any card.
- **Allow-list** intentional overlaps by a `data-overlap-ok` attribute, for example the waveform's region labels on the canvas. Keep the list short and justify each entry in a comment.

## 2. Cuts: remove parts of the song

### 2.1 What a cut is

A cut is a span of the **original** song, marked on the waveform, that the extended song skips. A cut stays attached to the song when repeat counts change.

- **Data:** `Cut { id, start, end }` in seconds.
- **Rules:**
  - Cuts can't overlap loops or each other. Refuse with a message like "Overlaps Loop 2 (1:20.000–1:30.000)".
  - Minimum length is 50 ms.
  - A cut may start at 0, which removes the intro, or run to the end of the song, which removes the outro.

### 2.2 Making and editing cuts

- **Making:** drag a selection on the waveform, then press **X** or click **Cut selection** next to the existing "Add loop".
- **On the waveform:** cuts show as dark hatched regions with a scissors label ✂. They can be dragged and resized like loops, with the same snapping rules: bars by default, Shift for free. Typed times are never snapped.
- **The Cuts card** lists every cut. Each row has:
  - the same exact Start and End fields as loops, with nudges (±10 ms, ±1 beat) and Set from playhead (reuse the components);
  - its length;
  - **Audition cut**, which plays 4 s before the join through 4 s after it;
  - **Remove**.
- **Shortcuts:** when a cut is selected, I and O set its edges, and Delete removes it.
- **Undo:** none needed beyond Remove.

### 2.3 Rendering

- **The timeline** skips cut spans wherever they fall in the plain parts of the song. Cuts are never inside loops, because the rules forbid overlap.
- **Each internal join** (song → skip → song) gets a crossfade:
  - the same crossfade as a plain loop seam (equal-power, adaptive law, zero-crossing snap), using the Seam fade length setting;
  - no Smooth seam rotation or bridge for cuts.
- **A cut at the very start:** the extended song starts at the cut's end, with a 10 ms fade-in to avoid a click.
- **A cut to the very end:** the song ends at the cut's start, with a 10 ms fade-out, or the Ending fade from section 3 if one is set.
- **Everywhere else:** `renderRange`, the live preview, export, extended length, the WAV cap check, the target-length solver, the extended timeline strip (✂ marks at cut joins) and the time mapping between original and extended all include cuts. Preview and export stay identical.
- **Tests:**
  - **Unit:** timeline and lengths with cuts at the start, middle and end; `renderRange` equivalence with cuts present; the join crossfade has no sample jump above threshold; overlap refusal.
  - **E2E:** make a cut by drag + X and by typed times, audition it, and export. The WAV duration equals the timeline within 20 ms.

## 3. Ending: end anywhere, then fade

### 3.1 The Ending card

```
Ending   ( ) Real ending   (•) End at [14:20.000] [Set from playhead]
Fade out [8.0] s           (0 = no fade)
```

- **End at** is a time on the **extended** timeline, entered with the time `NumberField`. It accepts `h:mm:ss.mmm`. **Set from playhead** works while playing Extended.
- **Fade out** is in seconds, from 0 to 60, step 0.1, typed or with a slider.
- **The curve** is an equal-power, cosine-shaped fade to silence ending exactly at the end point.
- **Validation:**
  - End at must be after 0 and within the extended length.
  - The fade can't be longer than End at.
  - Messages must be specific, for example "The extended song is only 6:12.000 long. End at must be before that."
- **If the extended song gets shorter** than End at, because repeats were lowered or a cut was added, switch to Real ending and show the notice "End point was past the new ending, so the song now ends at its real ending."
- **Target-length mode:** add a button **End exactly at target**. It sets End at = target. The repeats are solved as now (at least the target), so the song is trimmed to the exact target length and the fade lands on it.

### 3.2 Rendering

- **Output length** = the end point.
- **The fade** is a gain ramp over `[end − fade, end]`, applied in `renderRange`, so preview and export match.
- **Everything downstream** uses the final length: WAV cap, export and length panel ("3:42 → 14:20.000, fades over 8 s").
- **The extended timeline strip** shows the end point as a marker, dims everything after it, and shows the fade as a ramp.
- **Tests:**
  - **Unit:** output length; fade gain at sample level (exactly 0 at the end, about 0.707 at the fade's midpoint, 1 before the fade); `renderRange` equivalence across the fade; a real ending with a fade.
  - **E2E:** set End at and a fade, export, and the duration matches. A typed fade of 0 means no fade.

## 4. Wide layout: two columns

### 4.1 Narrow (below 1100 px)

Exactly the current single-column order, unchanged.

### 4.2 Wide (1100 px and up)

The container widens, up to about 1480 px with 24 px gutters, and uses CSS grid:

```
┌──────────────────────────── masthead + theme picker ────────────────────────────┐
├──────────────────────────── song strip (sleeve) ────────────────────────────────┤
├──────────────────────────── waveform panel (full width) ────────────────────────┤
├─────────────── main column (3fr) ─────────────┬──── side column (2fr) ───────────┤
│ Your loops                                    │ Suggested loops (tracklist)      │
│ Cuts                                          │ Length                           │
│ Ending                                        │                                  │
├──────────────────────────── extended timeline (full width) ─────────────────────┤
└──────────────────────────── turntable bar (sticky, full width) ─────────────────┘
```

- **Columns:** `grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr)`.
- **Card heights:** use `align-items: start` so cards keep their natural height and never stretch. The two columns grow independently.
- **Full width:** the waveform and the extended timeline stay full width, because their width is their precision.
- **Card internals** adapt to the extra width. At wide sizes, loop and cut rows lay their fields out on fewer lines, with Start and End fields side by side.
- **No horizontal scroll** at any width from 320 to 2560 px.
- **Test:** an e2e at 1440 px checks the two columns: the main column's cards sit left of the side column's cards with no overlap. At 1099 px the layout is one column again.

## 5. Themes

### 5.1 Theme system

- **The `data-skin` attribute.** Themes are selected by `data-skin="vinyl|studio|club|pro|space"` on `<html>`. Don't reuse `data-theme`: claude.ai sets that one for light/dark.
- **CSS structure:**
  - Each skin is a token block plus component overrides, scoped under `:root[data-skin='…']`.
  - Layout and markup are **shared**. Skins change tokens, typography, borders, shadows, decorative pseudo-elements and the play-button rendering, never the DOM order or the testids.
- **Light/dark:**
  - Skins that support both (Vinyl, Pro, Space) keep the established selector structure: every token defined on the bare skin selector first, then dark values under `@media (prefers-color-scheme: dark)` guarded by `:not([data-theme='light'])`, plus a `[data-theme='dark']` block.
  - **Single-look skins** (Studio and Club are dark by design) set every colour explicitly and `color-scheme: dark`, so they look right on any host background.
- **The theme picker** sits in the masthead, right-aligned. It's a labelled select ("Look") or a row of five swatch buttons with names, keyboard accessible, with the current skin marked.
  - The choice is stored in `localStorage`, wrapped in try/catch, with Vinyl as the fallback.
  - Switching skins doesn't reload anything or interrupt playback. The waveform re-reads its colours (`refreshTheme`).
- **Fonts:**
  - Each skin's Google Fonts `<link>` is injected only when that skin is first chosen, from `fonts.googleapis.com` only.
  - Every font stack has a real fallback.
  - Vinyl's fonts keep loading from `index.html`, as now.
  - In the final report, list every font URL. The artifact page may need them added.
- **The play button** is skin-specific: Vinyl's record, Studio's pad, Club's glow button, Pro's circle, Space's launch button. It is the same `<button>` with the same testid, `aria-pressed`, Play/Pause label and keyboard behaviour. Only CSS and pseudo-elements change.
- **Seam stamps** are restyled per skin. Their text (CLEAN / OK / ROUGH) stays visible in every skin, for accessibility and for tests.
- **The waveform** reads its wave, progress, cursor, region and grid colours from tokens in every skin. wavesurfer v7 accepts gradient arrays for `waveColor`, so Club and Space can use them.
- **Motion:** every skin respects `prefers-reduced-motion`. Each skin gets at most one signature motion, described below.

### 5.2 The skins

All the skins must meet WCAG AA text contrast, work at 380 px with no horizontal scroll, and pass the overlap test from section 1.

#### Vinyl (default)

The current design, plus the section 1 fixes. No other changes.

#### Studio hardware (dark only)

A high-end sampler or drum machine.

- **Tokens:**
  - surfaces: `--bg #141517`, `--panel #1e2023`, `--panel-2 #262a2e`
  - text and lines: `--ink #ece8df`, `--ink-soft #9b978e`, `--rule #33373c`
  - accents: `--accent` amber `#ffb000`, LCD background `#231a00`, LED green `#3ddc6a`, LED amber `#ffb000`, LED red `#ff4a3d`
  - loops: amber, `#38c6d9`, `#e2559c`, `#3ddc6a`, `#d9d4c7`
- **Type:**
  - labels: IBM Plex Sans Condensed (500/600, uppercase, letter-spaced)
  - numbers and times: IBM Plex Mono
  - the **LCD time readout**: VT323 in amber on the LCD background, with a faint glow
- **Panels** have a subtle top bevel (a 1 px light line), small corner screws (CSS radial dots) and 6 px radii.
- **Play** is a square rubber pad (72 px) with a ring of LEDs around it that lights amber while playing.
- **Seam stamps** become a three-LED meter with its label: CLEAN 3 green, OK 2 amber, ROUGH 1 red.
- **Suggestions** read like a pattern list. **Loops** are channel strips with a coloured LED stripe.
- **Signature motion:** the LED ring chases around the pad while playing.

#### Night club (dark only)

- **Tokens:**
  - surfaces: `--bg #07060b`, `--panel #110f19`, `--panel-2 #191526`
  - text: `--ink #f4f1ff`, `--ink-soft #a49fbd`
  - `--rule` rgba(255,47,185,0.18)
  - accents: magenta `#ff2fb9`, cyan `#19e3ff`
  - loops: magenta, cyan, `#ffd23f`, `#7cff6b`, `#b388ff`
- **Type:** Unbounded (700/800) for the display face, Manrope for body text, JetBrains Mono for numbers.
- **Look:**
  - the waveform is a magenta→cyan gradient with a soft glow (drop-shadow on its container);
  - cards are dark glass with 1 px glowing borders;
  - loops are neon pills.
- **Play** is a big round button (76 px) with a conic magenta/cyan ring that glows.
- **Signature motion:** while playing, the play ring and the waveform's played part pulse briefly on each beat. Use the analysed beat grid and the playback time, with requestAnimationFrame toggling a class, and nothing when there's no steady beat.
- Don't use a purple-to-blue gradient page background. The glow belongs to the controls and the waveform only.

#### Clean pro tool (light and dark)

A calm modern DAW.

- **Light tokens:**
  - surfaces: `--bg #f5f6f8`, `--panel #ffffff`
  - text and lines: `--ink #16181d`, `--ink-soft #5d6472`, `--rule #e2e5ea`
  - accent `#3d6df2`
- **Dark tokens:**
  - surfaces: `--bg #0f1115`, `--panel #171a20`
  - text and lines: `--ink #e8ebf0`, `--ink-soft #9aa3b2`, `--rule #262b33`
  - accent `#7aa2ff`
- **Loops:** a restrained set that works on both: `#3d6df2`, `#e5484d`, `#f5a524`, `#30a46c`, `#8e4ec6`, each with a lighter variant for dark mode.
- **Type:** Geist for text, Geist Mono for numbers.
- **Look:** hairline borders, no shadows, 8 px radii, generous spacing, one accent colour.
- **Play** is a 56 px solid accent circle.
- **Seam stamps** become small pills with a coloured dot.
- **Signature motion:** none, apart from a 120 ms ease on hover and focus.

#### Space age (retro-futurist, light and dark)

1960s–70s space-age hi-fi: moulded plastic, chrome and mission control.

- **Light tokens:**
  - surfaces: `--bg #ebe5d8` (moon dust), `--panel #f6f2ea`
  - text: `--ink #1b2030`, `--ink-soft #5c6170`
  - accents: `--accent` orange `#e8622a`, teal `#1f7a78`, chrome gradient `#d9dde3 → #a9b0ba`
- **Dark tokens:**
  - surfaces: `--bg #0b1222` (deep space), `--panel #141d33`
  - text: `--ink #e9e4d6`, `--ink-soft #9aa3b8`
  - accents: orange `#ff7a3d`, teal `#3fb7b2`
- **Type:** Michroma for the display face (wide, Eurostile-like, used sparingly for headings and labels), Exo 2 for body text, Share Tech Mono for numbers.
- **Look:**
  - panels have large radii (22 px) and a soft moulded inner shadow;
  - buttons are chrome-edged pills;
  - **the waveform window is a CRT scope**: a rounded bezel, dark glass, a phosphor-green trace (`#7cffb2`) with a slight glow and faint scanlines, in both light and dark;
  - loop regions are tinted overlays on the glass.
- **Play** is a round "launch" button (72 px) in orange with a thin orbit ring and a small dot that orbits while playing.
- **Seam stamps** become oval mission-patch badges.
- **Signature motion:** the orbiting dot.

### 5.3 Theme tests

- **E2E:** switching each skin sets `data-skin`, persists across reload, doesn't stop playback, and leaves no console errors.
- **The overlap test** from section 1 runs for every skin.
- **Contrast:** a script checks AA contrast for each skin's text tokens against its panel and background tokens, in both modes where both exist.
- **Fonts blocked:** each skin still renders with fallbacks. Abort the Google Fonts routes and check for no overlap and no errors.
- **Screenshots** go in `docs/themes/<skin>-<mode>-<wide|phone>.png` for every skin and mode, plus updated `docs/screenshot.png`.

## 6. Milestones (commit and push after each)

1. Overlap fixes (sleeve layout, hidden player bar before load, bottom padding) and `layout-overlap.spec.ts` for Vinyl.
2. Cuts: model, waveform, card, render, timeline, tests.
3. Ending: end point and fade, card, render, strip, target button, tests.
4. Wide two-column layout and its test.
5. Theme system and picker, persistence, font injection; Clean pro tool skin.
6. Studio hardware and Night club skins.
7. Space age skin.
8. Overlap, contrast and fonts-blocked tests across all skins; screenshots; README (cuts, ending, layout, themes); final full run.

---

## 7. Addendum: loop export, selection bar, suggestions placement

These were requested by the user after sections 1–6 were written. Sections 1–6 are built (through commit 90c9ae1). This section is built next, on top of them.

### 7.1 Export a loop as its own audio file

- **The button.** Each loop card gets an **Export loop** button (testid `export-loop`). It opens the export dialog in a "loop" mode with:
  - bit depth;
  - **Repeats in the file** (NumberField, 1–9,999, default 1);
  - **Loop-ready file** (checkbox, default on);
  - the speed/pitch bake checkbox;
  - a default file name `<song name> - Loop <n> (<start>-<end>).wav`, with times written `m.ss.mmm`. Colons aren't allowed in file names on Windows.
- **The span.** The file holds the loop's played span: the Smooth seam plan's rotated span (`loopStart`/`loopEnd`) when there is a plan, otherwise the loop's start and end.
- **Repeats.** N repeats means N passes with the app's normal seam between passes, rendered by the same renderer code, so the file matches the preview.
- **Not included:**
  - **Bridges.** The dialog shows a one-line note when the loop has Bridge on.
  - **Cuts and the Ending.** They don't apply to loop exports.
- **Loop-ready file.** The file must loop seamlessly when a DAW, sampler or player repeats it end-to-start.
  - Crossfade the file's last W samples with `orig[start − W, start)`, the audio just before the loop's start. Use equal-power with the existing adaptive law.
  - W is the Seam fade setting, with a minimum of 10 ms.
  - If `start − W < 0`, use what exists and fade the rest.
- **Path.** It uses the same piece-by-piece export, the WAV cap check, and `src/audio/save.ts` (zipped inside artifacts).
- **Tests:**
  - **Unit:** a loop-ready file joined to itself has no sample jump at the join above the seam tests' threshold. The N-repeat file equals the matching span of `renderRange` for a plan with just that loop. File names are sanitised.
  - **E2E:** export with 1 repeat (loop-ready) and with 4. Durations match, and artifact mode gives a zip.

### 7.2 Selection timestamps, typable

- **The selection bar.** While a selection exists on the waveform (before L or X), show a bar directly under the waveform (testid `selection-bar`) with:
  - Start and End time fields (NumberField);
  - Length (read-only, seconds and bars);
  - buttons **Add as loop** (= L), **Cut** (= X) and **Clear**.
- **Typing.** Typed values move the selection immediately. They're exact and never snapped, with the same parsing, validation and messages as loop fields. Escape reverts.
- **I and O.** They set the selection's edges from the playhead when no loop or cut is selected, and the fields update.
- **Edge labels.** Small mono timestamps at the selection's two edges on the waveform, e.g. `1:09.600`.
  - They never overlap each other or run off the waveform: flip them inside near the edges.
  - When the selection is narrow, show one combined label `1:09.600–1:12.000`.
  - Allow-list them in the overlap test only where they sit over the canvas on purpose.
- **Hidden** when there is no selection.
- **Styling.** Styled in every skin, and it passes the overlap and contrast checks.
- **Tests (E2E):** drag a selection and the bar shows the right times. Type new times and the region moves. Add as loop and Cut use the typed times exactly.

### 7.3 Suggested loops: collapsible, directly under "Your loops"

- **The toggle.** A disclosure toggle in the card header: a button with a chevron and "Suggested loops (12)", with `aria-expanded`/`aria-controls` and testid `suggestions-toggle`.
  - Collapsed shows only the header.
  - Default is expanded. The user's choice persists in `localStorage` (try/catch).
  - During analysis the header reads "Finding loops…", and the toggle still works.
- **Placement.** It sits directly under "Your loops" in every layout. This replaces the column assignment in 4.2:
  - **Wide:** main column (3fr) = Your loops, then Suggested loops. Side column (2fr) = Cuts, Ending, Length.
  - **Narrow order:** waveform, selection bar, Your loops, Suggested loops, Cuts, Ending, Length, extended timeline.
  - Update the wide-layout and overlap tests.
- **Unchanged.** Keep every existing suggestion testid and behaviour: Preview, Audition seam, Add, Show the whole side.
