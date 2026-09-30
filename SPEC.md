# Song Looper: Build Spec (v1)

A static web app. The user drops in an audio file. The app finds sections that loop cleanly and shows them on the waveform. The user picks one or more sections, sets how many times each repeats, previews the result, and exports an extended version of the song as a WAV.

Everything runs in the browser. No server, no API keys, no uploads.

## 1. Goals and non-goals

### In scope for v1

- Load a local audio file (mp3, wav, m4a/aac, flac, ogg, whatever `decodeAudioData` accepts in the current browser).
- Analyze the song in a Web Worker and suggest ranked loop candidates.
- Show the waveform with suggested loops drawn over it. The user can drag and resize regions to fine-tune.
- Support several loop regions per song. Each region has its own repeat count.
- Set the length of the extended song by repeat count per region, or by a target total duration that the app splits across regions.
- Splice the regions into the original song: intro plays, region A repeats N times, song continues, region B repeats M times, song continues to its real ending.
- Seam audition: play a few seconds across a loop seam to hear whether the jump is clean.
- Speed (tempo without pitch change) and pitch (semitones without tempo change) for preview playback.
- Export WAV. A checkbox in the export dialog decides whether speed/pitch go into the file.
- Deploy to GitHub Pages.

### Out of scope for v1 (keep the code open to these)

- AI labeling of sections. Leave a `labelProvider` interface so an optional NVIDIA/LLM labeler can be added later.
- Saving loops between sessions.
- Infinite Jukebox style random branching.
- MP3/AAC export.
- Streaming URLs or YouTube input.

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Build | Vite + TypeScript (strict) | Fast, static output for GitHub Pages |
| UI | Vanilla TS with small modules, or Preact if state gets messy. No heavy framework. | App is one screen |
| Waveform + regions | `wavesurfer.js` v7 + Regions plugin | Drag/resize regions built in |
| FFT | `fft.js` (MIT) | Small, fast, no WASM |
| Time-stretch / pitch-shift | `@soundtouchjs/core` or `soundtouchjs` (LGPL) | Works offline for export and in an AudioWorklet for preview |
| Tests | Vitest (unit), Playwright (smoke; Chromium is at `/opt/pw-browsers`) | |

Libraries to avoid:

- **Essentia.js**: AGPL-3.0 and a large WASM payload. Write the DSP in TypeScript instead (section 4). It is a few hundred lines and fully testable.
- **Rubber Band WASM**: GPL, and it needs COOP/COEP headers that GitHub Pages cannot set.

## 3. User flow and UI

One page, top to bottom:

1. **Drop zone.** "Drop a song or click to choose." After a file loads, show the filename, duration, sample rate, and a progress bar while analysis runs ("Finding beats... Comparing sections... Ranking loops...").
2. **Waveform panel** (wavesurfer). Shows the original song.
   - Faint beat grid lines, with bar lines drawn stronger.
   - Section boundaries from analysis as thin labeled markers (A, B, C...).
   - Loop regions the user has added, in distinct colors.
   - Click to seek. Space to play/pause.
3. **Suggestions list.** Top 8 to 12 candidates, sorted by score. Each row shows:
   - Start and end time, length in bars and seconds.
   - Score as 1 to 5 stars plus a short reason, e.g. "Seam match 94%, full section B, repeats 3x in song".
   - Buttons: **Preview** (plays the region looping), **Audition seam**, **Add**.
   - Hovering a row highlights that span on the waveform.
4. **Loop regions list** (the ones the user added). Each row:
   - Color swatch, start/end, bars.
   - Repeat count stepper (1 to 64). 1 means play once, the same as the original.
   - Toggle "snap to bars" (default on). With snap on, dragging edges snaps to bar lines. With it off, edges snap to beats. Shift-drag turns snapping off.
   - **Audition seam**, **Remove**.
   - Regions cannot overlap. Refuse or clamp overlapping drags.
5. **Length panel.**
   - Mode switch: "Repeat counts" or "Target length".
   - Target length: mm:ss input. The app works out repeat counts (section 5.3) and shows the actual resulting length, since it rounds to whole repeats.
   - Always shows: original length → extended length.
6. **Extended timeline strip.** A thin horizontal bar showing the output: plain blocks for original audio, colored blocks for each repeat. Clicking a spot seeks the extended preview.
7. **Transport.** Play original / Play extended toggle, play/pause, position.
   - Speed slider 0.5x to 1.5x (tempo only), pitch stepper −12 to +12 semitones, reset button.
8. **Export button** opens a dialog:
   - Checkbox "Apply speed and pitch changes" (default off; disabled if both are at neutral).
   - Bit depth: 16-bit PCM (default), 24-bit PCM, 32-bit float.
   - File name default: `<original name> (extended).wav`.
   - Progress bar during render. Warn if the estimated file is over 500 MB.

Keyboard: Space play/pause, `L` add a loop at the current selection, `Delete` removes the selected region.

Include a light and dark theme that follows `prefers-color-scheme`. The layout must work down to about 380px wide.

## 4. Analysis pipeline (Web Worker)

Input: mono downmix of the decoded audio. Resample to 22050 Hz with `OfflineAudioContext` on the main thread before sending it to the worker. Send the `Float32Array` as a transferable.

Everything below runs in `src/analysis/` as pure functions, so it can be unit tested outside the worker.

### 4.1 STFT

- Hann window 2048, hop 512 (about 23 ms per frame at 22050 Hz).
- Keep magnitude spectra.

### 4.2 Onset strength

- Log-compress magnitudes: `log(1 + 100 * mag)`.
- Spectral flux: sum over bins of the half-wave rectified difference from the previous frame.
- Subtract a local mean (about 0.5 s moving average), clip at 0, then normalize.

### 4.3 Tempo

- Autocorrelate the onset envelope over lags matching 60 to 200 BPM.
- Weight by a log-normal prior centered at 120 BPM (σ about 1 octave) to reduce half/double tempo mistakes.
- Pick the best lag. Also keep the second-best tempo for a UI override ("Tempo: 128 BPM ▾ half / double").

### 4.4 Beat tracking

- Dynamic programming beat tracker (Ellis 2007, the method `librosa.beat.beat_track` uses): score = onset strength + α · log-Gaussian penalty on deviation from the target period. α around 100 (librosa's "tightness").
- Backtrack from the best final frame. Trim weak beats at the start and end.
- Output: beat times in seconds.

### 4.5 Bars (downbeats)

- Assume 4/4 by default. Let the user switch to 3/4 or 6/8 in the UI.
- Choose the bar phase (0 to beatsPerBar−1) that maximizes the mean of (onset strength + low-frequency energy under ~150 Hz) on the candidate downbeats.
- Add a UI control "Shift bar line ◀ ▶" to nudge the phase by one beat, because automatic downbeat detection is unreliable.

### 4.6 Beat-synchronous features

For each beat interval, average over its frames:

- **Chroma (12)**: map each FFT bin between 55 Hz and 5 kHz to its pitch class, sum magnitudes, L2 normalize.
- **Timbre (13)**: 40-band mel spectrum → log → DCT → take coefficients 1 to 13 (drop coefficient 0). Z-score each coefficient over the song.
- **Loudness (1)**: RMS in dB.

Combined feature vector: `[chroma * wC, timbre * wT]` with wC = 1.0 and wT = 0.6 at the start. Put these in a config object so they are easy to tune.

### 4.7 Self-similarity matrix

- Beat-by-beat cosine similarity matrix `S` (N×N, N is usually 300 to 800 beats; fine as a `Float32Array`).
- Time-delay embedding: stack each beat's features with the next `k = 4` beats before computing similarity. That makes the matrix compare short phrases, which gives much cleaner diagonals.

### 4.8 Section boundaries

- Novelty curve: slide a Gaussian-tapered checkerboard kernel (size 16 beats) along the diagonal of `S`.
- Peak-pick with a minimum gap of 8 beats and snap to the nearest bar line.
- Cluster segments by mean feature vector (agglomerative, cosine distance, threshold in config) and label them A, B, C in order of first appearance. The label that repeats most and has the highest mean loudness gets the hint "likely chorus". Keep this as a hint and don't overclaim it.

### 4.9 Loop candidates

A loop region `[a, b)` (beat indices, a < b) sounds seamless when playback can jump from beat `b` back to beat `a` without an audible change. That holds when the music around `a` sounds like the music around `b`.

For every pair where:

- `a` and `b` are both bar starts,
- length `b − a` is a whole number of bars from 2 to 32 (prefer 4, 8, 16),
- length in seconds is at least 4 s and at most 50% of the song,

compute:

1. **Seam score** (weight 0.5): mean of `S[a + j][b + j]` for `j` in `[−4, +4)`. This is the diagonal of the matrix around the jump. It means "what plays right before and after `b` sounds like what plays right before and after `a`".
2. **Structure score** (weight 0.25): 1.0 if both `a` and `b` are section boundaries, 0.5 if one is, 0 otherwise. +0.2 bonus (capped at 1.0) if `[a, b)` is exactly one or more whole segments.
3. **Energy continuity** (weight 0.15): `1 − min(1, |loudness(b−1) − loudness(a)| / 6 dB)`.
4. **Length preference** (weight 0.10): 1.0 for 4, 8 or 16 bars, 0.7 for other even bar counts, 0.4 for odd.

Total score in [0, 1]. Then:

- Non-maximum suppression: drop any candidate that overlaps a better one by more than 60%.
- Keep the top 12.
- Each candidate gets a reason string built from its biggest component scores.

Budget: analysis of a 5-minute song should finish in under 5 s on a mid-range laptop. The candidate search is O(bars² · k) and cheap.

### 4.10 Worker protocol

```ts
// main → worker
{ type: 'analyze', samples: Float32Array, sampleRate: 22050, beatsPerBar: 4 }
// worker → main
{ type: 'progress', stage: 'stft' | 'beats' | 'features' | 'ssm' | 'candidates', pct: number }
{ type: 'result', analysis: Analysis }
{ type: 'error', message: string }
```

```ts
interface Analysis {
  bpm: number; bpmAlt: number;
  beats: number[];            // seconds
  beatsPerBar: number;
  barPhase: number;           // index into beats of the first downbeat
  sections: { start: number; end: number; label: string; hint?: string }[];
  candidates: {
    start: number; end: number;          // seconds, on beat times
    startBeat: number; endBeat: number;
    bars: number; score: number;
    components: { seam: number; structure: number; energy: number; length: number };
    reason: string;
  }[];
}
```

Changing beatsPerBar or bar phase re-runs only 4.5 onward (keep the STFT and features cached in the worker).

## 5. Splicing and rendering

### 5.1 Data model

```ts
interface LoopRegion { id: string; start: number; end: number; repeats: number; color: string } // seconds
interface Plan { regions: LoopRegion[] }  // sorted, non-overlapping
```

### 5.2 Timeline

Build a list of segments over the original buffer:

```
[0, r1.start) → r1 × repeats1 → [r1.end, r2.start) → r2 × repeats2 → ... → [rk.end, duration)
```

`repeats = 1` gives the original song back unchanged. Put this in a pure function `buildTimeline(plan, duration): Segment[]` with unit tests.

### 5.3 Target duration mode

Given target `T` and original length `D`:

- extra = T − D. If extra ≤ 0, all repeats = 1.
- Split the extra time across regions in proportion to each region's score (or equally for user-drawn regions without a score). Round each to whole extra repeats.
- Fix rounding by adding or removing one repeat at a time on the region that brings the total closest to T.
- Show the actual resulting length.

### 5.4 Seam crossfade

Each jump from `region.end` back to `region.start` gets an equal-power crossfade:

- Crossfade length `W` = 20 ms by default (config range 5 to 80 ms; expose as "Seam smoothing" in an advanced section).
- Around the seam, mix `orig[end − W/2 .. end + W/2]` fading out with `orig[start − W/2 .. start + W/2]` fading in. Clamp at buffer edges.
- Before rendering, snap `start` and `end` to the nearest zero crossing within ±2 ms on the mid channel (L+R)/2, but move both channels by the same offset so the stereo image stays aligned.
- The seams between the loop and the surrounding original audio (entering the first repeat, leaving the last one) are continuous in the original and need no crossfade.

### 5.5 Render

- `renderExtended(buffer: AudioBuffer, plan): Float32Array[]` (one array per channel) copies segments and applies crossfades. Run it in a worker for long outputs.
- Preview uses the same renderer, so the preview and the export are identical. Re-render on plan change, debounced by 300 ms.
- Memory guard: cap the extended length at 60 minutes. Show an error above that.

### 5.6 Speed and pitch

- Preview: run the rendered buffer through a SoundTouch AudioWorklet node. Tempo and pitch change live.
- Export with the box ticked: process the rendered channels offline through SoundTouch in a worker, with progress reports.
- Export with the box unticked: skip SoundTouch.

### 5.7 WAV encoder

Write it by hand (small, no dependency): RIFF header, `fmt ` chunk (PCM format 1 for 16/24-bit, IEEE float format 3 for 32-bit), `data` chunk, interleaved samples. Dither 16-bit output with TPDF dither. Output a `Blob` and download it through an object URL. Unit test the header bytes.

## 6. Seam audition

"Audition seam" plays `[end − 4 s, end)` and then jumps to `[start, start + 4 s)`, through the same crossfade code as the renderer. The easiest way is to render that 8 s snippet with `renderExtended` on a two-segment plan and play it.

## 7. Project layout

```
index.html
src/
  main.ts                 # wiring
  ui/                     # dropzone, waveform, suggestions, regions, lengthPanel, timeline, transport, exportDialog
  audio/
    decode.ts             # file → AudioBuffer, mono 22.05k downmix
    player.ts             # playback, SoundTouch worklet
    render.ts             # buildTimeline, renderExtended, crossfade, zero-cross snap
    wav.ts                # encoder
    stretch.ts            # offline SoundTouch
  analysis/
    stft.ts onset.ts tempo.ts beats.ts bars.ts features.ts ssm.ts sections.ts candidates.ts
    config.ts             # all weights and thresholds
    worker.ts
  label/
    provider.ts           # interface LabelProvider { label(analysis, candidates): Promise<string[]> }, no-op default
tests/
  unit/                   # vitest
  e2e/                    # playwright smoke
  fixtures/               # generated audio only; no copyrighted music in the repo
.github/workflows/deploy.yml  # build + deploy to GitHub Pages
```

## 8. Testing

Unit (Vitest) using synthesized audio built in the test code:

- **Tempo/beats:** click track at 100, 120 and 140 BPM. BPM within ±1. Beat times within ±30 ms of truth for at least 90% of beats.
- **Candidates:** synthetic "song" with structure A B A B C A, where A, B, C are different chord loops (sine or saw chords) with a kick on every beat. The top candidate must start and end on the A/B boundaries, and a full A or A+B loop must be in the top 3.
- **Timeline:** repeats = 1 everywhere reproduces the input sample for sample (with crossfades off). Output length = D + Σ (repeats − 1) · regionLength.
- **Target duration:** for several T values, the result is within half of the shortest region length of T.
- **Crossfade:** a constant-amplitude sine looped on whole periods has no sample jump above a small threshold at the seam.
- **WAV:** header fields correct for 16, 24 and 32-float; round-trip decode with `decodeAudioData` in Playwright.

E2E (Playwright, Chromium at `/opt/pw-browsers/chromium`):

- Load a generated fixture WAV, wait for suggestions, add the top one, set repeats to 3, export, check the downloaded file's duration.

Run `npm run lint`, `npm run typecheck`, `npm test` and the e2e suite before each commit.

## 9. Milestones

Build in this order and commit after each one:

1. Scaffold: Vite + TS, lint, Vitest, Playwright, Pages deploy workflow.
2. Load file, decode, waveform display, basic play/pause.
3. Render core: `buildTimeline`, `renderExtended`, crossfade, WAV export, with manual regions only. This alone gives a working tool.
4. Analysis worker: STFT, onset, tempo, beats, bars. Beat/bar grid on the waveform and snapping.
5. Features, similarity matrix, sections, candidates. Suggestions list with preview and audition.
6. Several regions, target-duration mode, extended timeline strip.
7. Speed/pitch preview and optional baking into export.
8. Polish: dark mode, mobile layout, keyboard shortcuts, error states (unsupported file, very short song, no beats found, silent audio).

## 10. Edge cases

- Songs under 20 s: skip suggestions and allow manual regions only.
- No clear beat (ambient, classical): if beat confidence is low, show "No steady beat found. Suggestions may be rough." and fall back to snapping to 0.5 s.
- Tempo drift (live recordings): the DP tracker follows moderate drift. Candidates use beat indices, so they still line up.
- Mono files: handle 1 channel throughout.
- Sample rates other than 44.1k: render at the file's native rate. Only analysis runs at 22.05k.
- Very long files (over 20 minutes): warn, and still try.
