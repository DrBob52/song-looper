# Song Looper: Seamless Seams (v1.1 spec)

Builds on SPEC.md and the code on this branch. Goal: when a loop isn't a perfect loop, the join from its end back to its start should sound like part of the original song.

The main problem the user hears is **harmony jumps**: the chord or melody at the loop's end doesn't lead back into its start. The user's decisions:

- The app **may move loop points automatically by up to one beat**, show what moved, and offer Undo.
- **Bridging** (borrowing bars from elsewhere in the song) is an **opt-in per loop**, off by default.
- **Stem separation is a later phase.** Leave it out of this build.
- No LLM or generative audio. Everything is signal processing on data the analysis worker already has.

## 1. Why a crossfade can't fix harmony

A crossfade blends two sounds. When the chords on either side of the seam clash, a longer fade makes it worse: you hear both chords at once. So harmony is handled by choosing **where** the seam is (sections 2, 4, 5). Blending (section 3) handles timing and timbre.

## 2. Harmonic transition model (analysis worker)

Idea: the song itself shows which chord changes sound natural. Jumping from the beat before the loop end (`b−1`) to the loop start (`a`) is natural when the song somewhere plays a beat like `b−1` followed by a beat like `a`.

### 2.1 Chroma similarity

- `C[i][j]` = cosine similarity of the per-beat chroma vectors (already computed in `features.ts`), with no delay embedding. It's N×N as a `Float32Array`, and N is usually under 1000.

### 2.2 Transition evidence

For a seam from beat `x` (last beat played) to beat `y` (next beat played), use a window of `w` beats on each side (`w = 2` by default, in config as `harmony.windowBeats`):

```
evidence(x → y) = max over t of  min( C[x−w+1+k][t−w+k]  for k in 0..w−1,      // lead-in matches
                                      C[y+k][t+k]         for k in 0..w−1 )    // continuation matches
```

In words: some place `t` in the song has a lead-in that sounds like the loop's last `w` beats, and a continuation that sounds like the loop's first `w` beats.

- Skip `t` values whose window runs off either end of the song.
- The natural continuation (`y = x + 1`) always has evidence 1.
- Exclude the trivial match where `t = y`, the loop start itself, when `x` is not `y − 1`. Otherwise every seam would find itself.
- To keep one lucky match from deciding it, use the mean of the top 2 values of `t` that are at least one bar apart.

### 2.3 Normalizing per song

A song that sits on one chord makes every `C` value high. Normalize against the song's own distribution:

- Sample about 2000 random beat pairs `(x, y)` with `y` not `x + 1`.
- `harmony = clamp((evidence − p50) / (p95 − p50), 0, 1)`, using the median and 95th percentile of that sample.
- If `p95 − p50 < 0.02` (harmonically static song), set `harmony = 1` for every seam and let the other scores decide.

### 2.4 Cost

For each loop candidate this is O(N · w). Compute it only at bar starts for `a` and bar ends for `b − 1`, since candidates are bar-aligned. Precompute `C` once. It must stay inside the existing 5 s analysis budget for a 5-minute song.

## 3. Smooth seam (per loop, on by default)

When smoothing is on, it runs on every user loop and every suggestion preview. Each loop row gets a **Smooth seam** checkbox (default on).

### 3.1 Rotation (moves the seam up to one beat)

Shift **both** loop edges by the same amount δ, with |δ| ≤ one beat. The loop keeps its exact length, so the groove and repeat timing don't change. Only the point where the join happens moves.

Search δ in quarter-beat steps from −1 to +1 beat. Then refine the best two in 5 ms steps within ±30 ms. Score each δ by:

1. **Transient cover** (weight 0.4): onset strength at `start + δ` in the fine onset curve. The seam hides best right before a strong hit.
2. **Spectral continuity** (weight 0.4): compare the spectral flux across the seam (the last frame before the loop end against the first frame at the loop start) with the song's typical flux at that position in the bar. Score = `1 − min(1, seamFlux / (2 · typicalFlux))`.
3. **Harmony** (weight 0.2): `harmony(b−1+δ → a+δ)`, taken from the nearest beat.

### 3.2 Micro-alignment (fixes flams and doubled hits)

After rotation, allow the **end** edge alone to move by ±20 ms. Take the lag with the highest cross-correlation of the fine onset curves around the two edges, and fall back to the mid-channel waveform when the onsets are flat. This corrects beat-grid errors, so a drum hit lands once and not twice. Cap it at 20 ms so the loop length never changes audibly.

### 3.3 Adaptive fade

- Try fade lengths {10, 20, 40, 80, 160 ms, one beat} and pick the one with the lowest spectral discontinuity across the rendered seam.
- If harmony at the seam is below 0.5, limit the choice to 40 ms or less, placed right before the transient from 3.1. A long fade smears the two chords together.
- Keep the existing correlation-adaptive fade law and zero-crossing snap.

### 3.4 Level match

If the loudness over the last beat and the first beat differs by more than 1.5 dB, apply a linear gain ramp over the last beat of the loop so the two sides meet at the same level. The ramp applies only to repeats that jump back, so the final pass into the rest of the song is untouched.

### 3.5 What the user sees

The loop row shows:

- a one-line summary: `Seam moved +61 ms · aligned +7 ms · fade 40 ms`
- **Undo**, which restores the original points and turns smoothing off for that loop
- a **Seam** chip reading **Clean / OK / Rough**, with the before and after scores in its tooltip.

Seam quality combines the three scores in 3.1 with harmony weighted up to 0.5, since harmony is what the user hears. Chip thresholds go in config.

**Audition seam** plays the smoothed seam. Add **Hear original** next to it, which plays the raw seam for A/B comparison.

## 4. Nearby loops with a cleaner chord change (suggestions only)

When a user loop's harmony is under 0.5, search for loops that:

- keep the start within ±1 bar,
- move the end within ±2 bars,
- stay whole bars long.

Maximize harmony, with the existing loop score as tie-break. Show the best one under the loop row: `Cleaner chord change nearby: 0:16.0–0:47.9 (8 bars) [Audition] [Use]`. Moves bigger than one beat always wait for the user to click, per their decision.

## 5. Bridge (opt-in per loop, off by default)

When no seam from the loop end back to its start sounds natural, play a few bars of the song after the loop end, then jump back from a point where the chord change does occur in the song.

### 5.1 Search

This is a shortest path on a beat graph:

- **Natural edges:** `i → i+1`, cost 0.
- **Jump edges:** `i → j`, cost `1 − harmony(i → j)`, only where harmony ≥ 0.5 **and** `j` sits at the same position in the bar as `i + 1`. That keeps bar structure intact.
- **The path:** from beat `b − 1` (the loop's last beat) to beat `a` (its start), with a total length outside the loop of 1 to 4 whole bars and at most 2 jumps.
- **Obvious candidate:** continue straight into the original song after the loop end (`b, b+1, ...`), then jump back to `a` at the first bar line where the chord change occurs. Make sure the search finds this case.
- **When to offer it:** only when the path's worst jump beats the direct seam's harmony by at least 0.2.

### 5.2 Rendering

- Each repeat except the last plays `loop + bridge`. The last repeat flows into the rest of the song as now.
- Every jump inside a bridge gets the smooth-seam treatment from section 3.
- Timeline, extended length, the target-length solver, the extended timeline strip (bridges shown hatched in the loop's colour), seam audition and export all include bridges. Preview and export stay identical.

### 5.3 UI

- A **Bridge** toggle on each loop row, with a status line: `Bridge: 2 bars from 0:48, back at 1:12 (chord change found there)` or `No natural bridge found`.
- Show a hint, "Seam sounds rough? Try Bridge", when the seam chip reads Rough.

## 6. Suggestions ranking

Replace the seam score in `candidates.ts`:

```
contextMatch = max( mean S[a−1−j][b−1−j] for j in 0..3,     // lead-ins match
                    mean S[a+j][b+j]     for j in 0..3 )    // continuations match
seam = 0.5 · contextMatch + 0.5 · harmony(b−1 → a)
```

`S` is the existing delay-embedded similarity matrix. The old score demanded that both sides match. That penalized looping one whole section, such as a chorus followed by a verse, even when its chord change back to the start occurs elsewhere in the song.

Reason strings mention harmony, for example "Chords lead back cleanly" or "Chord change at the seam isn't in the song". All weights go in `config.ts`.

## 7. Tests

Extend `tests/fixtures/synth.ts` to build songs from named chord progressions, one chord per bar, with a kick on every beat.

**Harmony model:**

- **Song 1**, A = C G Am F, B = Dm Em F G, structure A B A B:
  - Loop A alone ends on F and returns to C. F → C never occurs in the song, so its harmony is below 0.35.
  - Loop A+B ends on G and returns to C. G → C occurs, so its harmony is above 0.8.
- **Song 2** is song 1 plus section C = Am F C G, which contains F → C. The same loop A now scores above 0.7.
- **Static song** (one chord throughout): harmony is 1 everywhere, and nothing crashes.

**Suggestions:** on song 2, loop A alone appears in the top 5.

**Rotation:** the loop length is exactly unchanged, and |δ| ≤ one beat. On a loop whose nominal start sits just after a snare hit, the chosen δ places the seam just before a hit.

**Micro-alignment:** a kick pattern with the loop's end edge offset +15 ms from the true beat is recovered within 2 ms. The rendered seam window then contains one kick onset, not two.

**Adaptive fade:** with harmony below 0.5, the fade is 40 ms or less.

**Level match:** a loop with a 3 dB crescendo has no level step above 0.5 dB at the seam after smoothing.

**Bridge:**

- On song 1, loop A with the bridge on finds a path of 4 bars or less whose jumps all have harmony ≥ 0.5.
- Render length = D + (repeats − 1) · (loop + bridge).
- The target solver counts bridge length.

**Undo:** restores the original points exactly.

**E2E:** load song 1 as a WAV fixture, add loop A, and see the chip read Rough. Turn on Bridge and the chip improves. Export, and the WAV duration matches the timeline within 20 ms.

Keep every existing test passing. Don't loosen a threshold without saying so in the final report.

## 8. Milestones (commit and push after each)

1. Harmony model in the worker, plus the new suggestion seam score, with tests. Suggestions improve on their own.
2. Worker message `seamReport(regions)` returning harmony, context match and chip per loop, plus the chip in the UI.
3. Smooth seam: rotation, micro-alignment, adaptive fade, level match; the summary line, Undo, and Hear original.
4. Nearby cleaner loops.
5. Bridge: search, timeline/render/solver/strip changes, UI.
6. README section "How seams are smoothed", screenshot update, and the artifact build still working. Downloads keep going through `src/audio/save.ts`.

## 9. Later (not this build)

- **Stem-aware blending:** separate drums, bass, vocals and other with HTDemucs in the browser (WebGPU), then give each stem its own seam. Drums cut on the hit; vocals and pads blend long.
- **Generative bridges:** audio inpainting models are still research-grade, with gaps under a second, trained mostly on classical and piano recordings. Revisit if that changes.
