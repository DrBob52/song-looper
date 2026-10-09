# Song Looper v1.4: Whole-Song Loop

Builds on all earlier specs and the code on this branch. Don't change existing behaviour.

## 1. What the user asked for

> An option to loop a song by tying its end back to its beginning, so the end of play 1 runs into the beginning of play 2 and each play is almost the full song.

This is a loop region that covers almost the whole song:

- Its **start** sits just after the intro.
- Its **end** sits just before the outro.

Played with N repeats through the existing timeline, it gives:

```
[intro] [song body] ↩ [song body] ↩ ... [song body] [outro]
  play 1 begins at 0:00          the last play runs on to the real ending
```

Each jump goes from near the end back to near the start, at a point where it sounds natural. That point has a matching beat position in the bar, a matching chord change and matching energy. Everything already built applies to it unchanged: the seam crossfade, Smooth seam, Bridge, typed times, Export loop, cuts outside it, the ending fade and the long-song limits.

The existing suggestions can't produce this kind of loop. They're capped by `candidates.maxBars` (32) and `maxSongFraction` (0.5), so the whole-song loop needs its own search.

## 2. The search (analysis worker)

Add `findWholeSongLoops(input)` in `src/analysis/wholeSong.ts`. Run it as part of the analysis and return the results in `Analysis.wholeSong` (an array, best first).

- **Search windows.** These are config values in `config.ts` under `wholeSong`:
  - The start `a` is a bar start within the first `startWindow` of the song: the smaller of 30% of the song and 90 s.
  - The end `b` is a bar start within the last `endWindow`: the smaller of 30% of the song and 90 s.
  - `b − a` is a whole number of bars and covers at least `minCoverage` (60%) of the song.
- **Score**, with every weight in config:
  - **seam** (0.45): the same seam score the suggestions use (`contextMatch` and harmony, from `candidates.ts`/the harmony model). Reuse that code; don't copy it.
  - **structure** (0.25): 1.0 when both `a` and `b` sit on detected section boundaries, 0.5 when one does. It rewards jumping from the start of the outro back to the start of verse 1.
  - **energy** (0.15): the existing energy continuity across the jump.
  - **coverage** (0.15): `(b − a) / duration`, so more of the song per play scores higher.
- **Results.** Apply non-maximum suppression, so no two options sit within 2 bars of each other at both edges. Return the top 3, each with:
  - `start`, `end`, `startBeat`, `endBeat`, `bars`, `score`, `components`;
  - `skipsIntro` (= start) and `skipsOutro` (= duration − end), in seconds;
  - a reason string, for example: "Chords lead back cleanly, jumps from the outro to verse 1, keeps 92% of the song".
- **When there's no result.** If the song is too short or has no steady beat, return an empty array. The UI then explains why.
- **Budget.** The search must keep a 5-minute song's analysis under the existing 5 s budget. Measure it and report the number.

## 3. UI: a "Loop the whole song" option

The **Your loops** card gets a button next to "+ Add loop": **↻ Whole song** (testid `whole-song`). It opens an inline panel (testid `whole-song-panel`) listing the up-to-3 options:

```
Option 1 ★★★★★  plays 0:12.004 → 3:31.880 · keeps 92%
  skips the first 0:12.0 and the last 0:18.1 of each repeat
  Chords lead back cleanly, jumps from the outro to verse 1
  [Audition jump]  [Use this]
```

- **Audition jump** plays 4 s before the end point, then 4 s from the start point, through the normal seam code, the same as Audition seam.
- **Use this:**
  - Adds the option as a normal loop with **2 plays** by default, labelled "Whole song" on its card.
  - The repeat field reads "Plays". A whole-song loop's card says "Plays" where other loops say "Repeats", since each repeat is a full play.
  - **Other loops** can't overlap a whole-song loop. If loops already exist inside its span, the panel shows "This replaces Loop 1 and Loop 2" and Use this asks for an in-page confirmation (no `confirm()`), then removes them.
  - **Cuts** inside the span are refused as now, so the panel shows "Remove the cut at 1:40.000 first" and disables Use for that option. Cuts outside it are fine.
- **Once added,** it's an ordinary loop: typed times, nudges, Smooth seam, Bridge, Export loop and so on all work.
- **Target length** works as it does now. For example, "make it 30 minutes" solves the number of plays.
- **No options found:** the panel says why. Either "The song is too short to loop as a whole" or "No steady beat found. Drag a selection from just after the intro to just before the outro and press L."
- **Styling.** Style the new elements in all five skins (Vinyl, Studio, Club, Pro, Space). They must pass the overlap test, `npm run contrast` and the fonts-blocked test, at 320 to 2560 px.

## 4. Tests

- **Unit, the search:**
  - Build a synthetic song: an 8-bar intro, then A B A B C A as the body, then a 4-bar outro whose chords differ from the intro. Assume the outro's first chord change back to the body's start occurs in the song.
  - The top option starts at the end of the intro and ends at the start of the outro, within 1 bar.
  - It covers at least 60%. Every option is bar-aligned.
  - The results are empty when the song is under 20 s or has no steady beat.
  - The budget test still passes.
- **Unit, rendering:** a whole-song loop with N plays renders as `D + (N − 1) · (end − start)`. `renderRange` matches the full render.
- **E2E:**
  - Open the panel and see 1 to 3 options with times. Audition jump plays.
  - Use this adds a loop with the label and 2 plays, and the extended length is correct.
  - The replacement confirmation removes inner loops.
  - The cut conflict disables Use.
  - Export gives the right duration.
  - The layout and overlap checks pass in every skin.

## 5. Milestones (commit and push after each)

1. Search, config, `Analysis.wholeSong`, unit tests, timing.
2. UI panel, Use and Audition, Plays label, conflict handling, e2e.
3. Styling in all skins, overlap/contrast/fonts checks, README section "Loop the whole song", screenshot refresh, final full run.
