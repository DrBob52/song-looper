import { fadeWindow, seamCorrelation } from '../audio/render';
import type { SeamPlan } from '../model';
import { ANALYSIS_CONFIG } from './config';
import { FluxAccumulator } from './onset';
import { nearestBeat } from './seam';
import type { SeamAnalyzer } from './seam';
import { forEachFrame } from './stft';

type SeamConfig = typeof ANALYSIS_CONFIG.seam;
/** The seam tunables, widened from the `as const` config so tests can try other numbers. */
export type SmoothConfig = { [K in keyof SeamConfig]: SeamConfig[K] };

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Mono samples as an accessor that reads silence outside the signal. */
function reader(samples: Float32Array): (i: number) => number {
  return (i) => (i < 0 || i >= samples.length ? 0 : samples[i]!);
}

// ---------------------------------------------------------------------------
// Beat length
// ---------------------------------------------------------------------------

/** The length of a beat near time `t` (median of the beat intervals around it), or the fallback grid without a beat grid. */
export function localBeatSeconds(tool: SeamAnalyzer, t: number): number {
  if (!tool.hasGrid) return ANALYSIS_CONFIG.limits.fallbackGridSeconds;
  const { beats } = tool.inputs;
  const i = nearestBeat(beats, t);
  const d: number[] = [];
  for (let k = Math.max(0, i - 8); k < Math.min(beats.length - 1, i + 8); k++) d.push(beats[k + 1]! - beats[k]!);
  if (d.length === 0) return ANALYSIS_CONFIG.limits.fallbackGridSeconds;
  d.sort((a, b) => a - b);
  return d[d.length >> 1]!;
}

// ---------------------------------------------------------------------------
// 3.1 Rotation
// ---------------------------------------------------------------------------

export interface Rotation {
  /** Seconds that both edges move by (positive: later). */
  shift: number;
  /** Rotation score of the chosen shift and of not moving. */
  score: number;
  baseScore: number;
}

/**
 * Pick how far to move both loop edges (up to one beat either way, the loop keeps its length): quarter-beat steps,
 * the best two refined in 5 ms steps, each scored by transient cover, spectral continuity and harmony. `lo` and
 * `hi` bound the shift (the free space around the loop and the song edges).
 */
export function chooseRotation(
  tool: SeamAnalyzer,
  start: number,
  end: number,
  lo: number,
  hi: number,
  cfg: SmoothConfig = ANALYSIS_CONFIG.seam,
): Rotation {
  const rc = cfg.rotation;
  const beat = localBeatSeconds(tool, start);
  /** `sharp`: the transient term is the cover (a hit just ahead); otherwise it is the tolerant "a hit is near". */
  const score = (d: number, sharp: boolean): number => {
    const s = start + d;
    const e = end + d;
    const t = sharp ? tool.transientCover(s) : tool.transientNear(s);
    const sp = tool.spectralContinuity(e, s);
    const h = tool.harmonyAt(e, s);
    const w = rc.weights;
    const sum = w.transient * t + w.spectral * sp + (h === null ? 0 : w.harmony * h);
    const weight = w.transient + w.spectral + (h === null ? 0 : w.harmony);
    return sum / weight - rc.movePenalty * (Math.abs(d) / beat);
  };
  const baseScore = score(0, true);
  if (!tool.hasGrid || hi - lo < 1e-4) return { shift: 0, score: baseScore, baseScore };

  const lower = Math.max(lo, -beat);
  const upper = Math.min(hi, beat);
  // Coarse: quarter-beat steps, judged by whether a hit is anywhere near, so that the steps beside a hit are the ones refined.
  const coarse: { d: number; s: number }[] = [];
  const steps = Math.round(1 / rc.stepBeats);
  for (let k = -steps; k <= steps; k++) {
    const d = k * rc.stepBeats * beat;
    if (d < lower - 1e-9 || d > upper + 1e-9) continue;
    coarse.push({ d, s: score(d, false) });
  }
  coarse.sort((a, b) => b.s - a.s || Math.abs(a.d) - Math.abs(b.d));
  // Fine: the best coarse steps, in small steps, judged by the cover (a hit just after the seam).
  let best = { d: 0, s: baseScore };
  const range = rc.refineRangeMs / 1000;
  const step = rc.refineStepMs / 1000;
  for (const c of coarse.slice(0, rc.refineTop)) {
    for (let d = c.d - range; d <= c.d + range + 1e-9; d += step) {
      const dd = clamp(d, lower, upper);
      const s = score(dd, true);
      if (s > best.s + 1e-12) best = { d: dd, s };
    }
  }
  if (best.s - baseScore < rc.minGain) return { shift: 0, score: baseScore, baseScore };
  return { shift: best.d, score: best.s, baseScore };
}

// ---------------------------------------------------------------------------
// 3.2 Micro-alignment
// ---------------------------------------------------------------------------

/** Fine onset curve (spectral flux) of `count` frames whose centres are `hop` samples apart, frame 0 centred on sample `first`. */
export function onsetAround(samples: Float32Array, first: number, count: number, frameSize: number, hop: number): Float32Array {
  const a = first - frameSize; // one extra frame of lead-in so that frame 0 has a predecessor
  const len = (count + 2) * hop + 2 * frameSize;
  const buf = new Float32Array(len);
  const from = Math.max(0, a);
  const to = Math.min(samples.length, a + len);
  if (to > from) buf.set(samples.subarray(from, to), from - a);
  // forEachFrame centres frame f on sample f * hop of `buf`
  const out = new Float32Array(count);
  const acc = new FluxAccumulator(frameSize / 2 + 1);
  const skip = Math.ceil(frameSize / hop); // frames before `first`
  forEachFrame(buf, { frameSize, hop }, (f, mags) => {
    const v = acc.push(mags);
    const k = f - skip;
    if (k >= 0 && k < count) out[k] = v;
  });
  return out;
}

export interface Alignment {
  /** Seconds that the end edge moves by. */
  align: number;
  method: 'onset' | 'waveform' | 'none';
  /** Normalised correlation at the chosen lag (and with no move). */
  corr: number;
  baseCorr: number;
}

/** Normalised cross-correlation of `a[lag + i]` with `b[i]` for i in [0, n), over lags in [-maxLag, maxLag]. */
function crossCorrelate(a: ArrayLike<number>, aOffset: number, b: ArrayLike<number>, n: number, maxLag: number): Float64Array {
  const out = new Float64Array(2 * maxLag + 1);
  let bb = 0;
  for (let i = 0; i < n; i++) bb += b[i]! * b[i]!;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let ab = 0;
    let aa = 0;
    const base = aOffset + lag;
    for (let i = 0; i < n; i++) {
      const x = a[base + i]!;
      ab += x * b[i]!;
      aa += x * x;
    }
    const denom = Math.sqrt(aa * bb);
    out[lag + maxLag] = denom > 1e-12 ? ab / denom : 0;
  }
  return out;
}

/** Parabolic refinement of the peak of `c` at index `k`, as a fractional index. */
function refinePeak(c: Float64Array, k: number): number {
  if (k <= 0 || k >= c.length - 1) return k;
  const y0 = c[k - 1]!;
  const y1 = c[k]!;
  const y2 = c[k + 1]!;
  const d = y0 - 2 * y1 + y2;
  return d < 0 ? k + clamp((0.5 * (y0 - y2)) / d, -1, 1) : k;
}

/**
 * Micro-alignment (SPEC-seams.md 3.2): how far to move the end edge (at most `maxMs`) so that a drum hit lands once and
 * not twice across the seam. Cross-correlates the fine onset curves around the two edges and takes the best lag; when
 * neither edge has a transient it correlates the waveforms instead.
 */
export function alignEnd(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
  cfg: SmoothConfig = ANALYSIS_CONFIG.seam,
): Alignment {
  const ac = cfg.align;
  const none: Alignment = { align: 0, method: 'none', corr: 0, baseCorr: 0 };
  const sEdge = Math.round(start * sampleRate);
  const eEdge = Math.round(end * sampleRate);

  // --- onset curves, anchored on each edge
  const hop = ac.hop;
  const lagFrames = Math.round((ac.maxMs / 1000) * sampleRate / hop);
  const before = Math.round((ac.beforeSeconds * sampleRate) / hop);
  const after = Math.round((ac.afterSeconds * sampleRate) / hop);
  const n = before + after + 1;
  const sFirst = sEdge - before * hop;
  const eFirst = eEdge - (before + lagFrames) * hop;
  const cs = onsetAround(samples, sFirst, n, ac.frameSize, hop);
  const ce = onsetAround(samples, eFirst, n + 2 * lagFrames, ac.frameSize, hop);
  const peak = (c: Float32Array): number => c.reduce((m, v) => (v > m ? v : m), 0);
  const peakS = peak(cs);
  const peakE = peak(ce);

  if (peakS >= ac.flatFlux || peakE >= ac.flatFlux) {
    if (peakS < ac.flatFlux || peakE < ac.flatFlux) return none; // a hit on one side only: nothing to line up
    const corr = crossCorrelate(ce, lagFrames, cs, n, lagFrames);
    // prefer the smallest move among near-equal peaks
    const dtMs = (hop / sampleRate) * 1000;
    let best = lagFrames;
    let bestV = -Infinity;
    for (let i = 0; i < corr.length; i++) {
      const v = corr[i]! - ac.movePenaltyPerMs * Math.abs(i - lagFrames) * dtMs;
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    const base = corr[lagFrames]!;
    if (corr[best]! - base < ac.minGain) return { align: 0, method: 'onset', corr: base, baseCorr: base };
    const frac = refinePeak(corr, best);
    const align = clamp(((frac - lagFrames) * hop) / sampleRate, -ac.maxMs / 1000, ac.maxMs / 1000);
    return { align, method: 'onset', corr: corr[best]!, baseCorr: base };
  }

  // --- no transients: line up the waveforms
  const maxLag = Math.round((ac.maxMs / 1000) * sampleRate);
  const w = Math.round((ac.waveformMs / 1000) * sampleRate);
  const at = reader(samples);
  const b = new Float64Array(2 * w);
  for (let i = 0; i < 2 * w; i++) b[i] = at(sEdge - w + i);
  const a = new Float64Array(2 * w + 2 * maxLag);
  for (let i = 0; i < a.length; i++) a[i] = at(eEdge - w - maxLag + i);
  const corr = crossCorrelate(a, maxLag, b, 2 * w, maxLag);
  let best = maxLag;
  let bestV = -Infinity;
  for (let i = 0; i < corr.length; i++) {
    const v = corr[i]! - ac.movePenaltyPerMs * (Math.abs(i - maxLag) / sampleRate) * 1000;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  const base = corr[maxLag]!;
  if (corr[best]! - base < ac.minGain) return { align: 0, method: 'waveform', corr: base, baseCorr: base };
  const align = clamp((refinePeak(corr, best) - maxLag) / sampleRate, -ac.maxMs / 1000, ac.maxMs / 1000);
  return { align, method: 'waveform', corr: corr[best]!, baseCorr: base };
}

// ---------------------------------------------------------------------------
// 3.3 Adaptive fade
// ---------------------------------------------------------------------------

/** Peak spectral flux (log-compressed, summed over bins) over the frames of `y` that lie within [zoneFrom, zoneTo). */
function zonePeak(y: Float32Array, frameSize: number, hop: number, zoneFrom: number, zoneTo: number, gamma: number): number {
  const acc = new FluxAccumulator(frameSize / 2 + 1, gamma);
  let peak = 0;
  forEachFrame(y, { frameSize, hop }, (f, mags) => {
    const v = acc.push(mags);
    const c = f * hop;
    if (c >= zoneFrom && c < zoneTo && v > peak) peak = v;
  });
  return peak;
}

/**
 * The extra spectral flux that a seam adds beyond the song's own: peak flux across the rendered seam (the jump from
 * `from` to `to` crossfaded over `fadeMs`, as the renderer would play it) minus the peak flux of the song itself at
 * `to`, over the same zone. Zero when the join is as smooth as the music.
 */
export function seamDiscontinuity(
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  fadeMs: number,
  cfg: SmoothConfig = ANALYSIS_CONFIG.seam,
): number {
  const fc = cfg.fade;
  const at = reader(samples);
  const f = Math.round(from * sampleRate);
  const t = Math.round(to * sampleRate);
  const half = Math.max(1, Math.floor((fadeMs / 1000) * sampleRate * 0.5));
  const ctx = Math.round((fc.contextMs / 1000) * sampleRate) + half;
  const rho = seamCorrelation(at, samples.length, t, f, half);
  const win = fadeWindow(half, rho);
  const len = 2 * ctx;
  const y = new Float32Array(len);
  const y0 = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const k = i - ctx; // position relative to the seam
    y[i] = k < -half ? at(f + k) : k >= half ? at(t + k) : win.out[k + half]! * at(f + k) + win.inn[k + half]! * at(t + k);
    y0[i] = at(t + k);
  }
  const pad = Math.round((fc.zonePadMs / 1000) * sampleRate) + fc.frameSize / 2;
  const zoneFrom = ctx - half - pad;
  const zoneTo = ctx + half + pad;
  const rendered = zonePeak(y, fc.frameSize, fc.hop, zoneFrom, zoneTo, fc.gamma);
  const natural = zonePeak(y0, fc.frameSize, fc.hop, zoneFrom, zoneTo, fc.gamma);
  return Math.max(0, rendered - natural);
}

export interface FadeChoice {
  fadeMs: number;
  /** The discontinuity of each allowed length, for inspection. */
  tried: { fadeMs: number; excess: number }[];
}

/**
 * Pick the crossfade length (SPEC-seams.md 3.3): of 10, 20, 40, 80, 160 ms and one beat, the shortest whose
 * discontinuity across the rendered seam is within a tolerance of the lowest. With harmony below 0.5 only fades of
 * 40 ms or less are allowed.
 */
export function chooseFade(
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  harmony: number | null,
  beatSeconds: number,
  cfg: SmoothConfig = ANALYSIS_CONFIG.seam,
): FadeChoice {
  const fc = cfg.fade;
  let lengths = [...fc.candidatesMs, Math.round(beatSeconds * 1000)];
  if (harmony !== null && harmony < fc.poorHarmony) lengths = lengths.filter((ms) => ms <= fc.poorMaxMs);
  lengths = [...new Set(lengths)].sort((a, b) => a - b);
  const tried = lengths.map((fadeMs) => ({ fadeMs, excess: seamDiscontinuity(samples, sampleRate, from, to, fadeMs, cfg) }));
  const best = Math.min(...tried.map((x) => x.excess));
  const limit = best + fc.tolerance * best + fc.floor;
  const pick = tried.find((x) => x.excess <= limit) ?? tried[0]!;
  return { fadeMs: pick.fadeMs, tried };
}

// ---------------------------------------------------------------------------
// 3.4 Level match
// ---------------------------------------------------------------------------

/** RMS level in dB of the samples in [from, to) seconds. */
export function levelDb(samples: Float32Array, sampleRate: number, from: number, to: number): number {
  const a = clamp(Math.round(from * sampleRate), 0, samples.length);
  const b = clamp(Math.round(to * sampleRate), 0, samples.length);
  if (b <= a) return -120;
  let s = 0;
  for (let i = a; i < b; i++) s += samples[i]! * samples[i]!;
  return 10 * Math.log10(s / (b - a) + 1e-12);
}

/**
 * The gain change (dB) to ramp over the last beat before the jump so that both sides meet at the same level
 * (SPEC-seams.md 3.4), or 0 when the last and first beat are within 1.5 dB of each other. The song's own accent
 * pattern between those two bar positions (a downbeat is usually louder than the beat before it) is not a level jump,
 * so only the excess over it counts; without it every natural seam would get a swell.
 */
export function chooseLevel(
  tool: SeamAnalyzer,
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  beatSeconds: number,
  cfg: SmoothConfig = ANALYSIS_CONFIG.seam,
): number {
  const lc = cfg.level;
  const last = levelDb(samples, sampleRate, from - beatSeconds, from);
  const first = levelDb(samples, sampleRate, to, to + beatSeconds);
  if (last < -90 || first < -90) return 0;
  const pair = tool.seamBeats(from, to);
  const accent = pair ? tool.accentStep(pair.x, pair.y) : 0;
  const diff = first - last - accent;
  if (Math.abs(diff) <= lc.thresholdDb) return 0;
  return clamp(diff, -lc.maxDb, lc.maxDb);
}

// ---------------------------------------------------------------------------
// Everything together
// ---------------------------------------------------------------------------

export interface SmoothInput {
  start: number;
  end: number;
  /** The loop's edges may move within [minStart, maxEnd]. */
  minStart?: number;
  maxEnd?: number;
}

/**
 * Smooth one seam: rotate both edges, align the end edge, pick the fade and the level ramp (SPEC-seams.md 3). Returns
 * the plan for playing the loop; the loop's own points are left as the user set them.
 */
export function smoothSeam(
  tool: SeamAnalyzer,
  samples: Float32Array,
  sampleRate: number,
  input: SmoothInput,
  cfg: SmoothConfig = ANALYSIS_CONFIG.seam,
): SeamPlan {
  const { start, end } = input;
  const duration = tool.inputs.duration;
  const minStart = Math.max(0, input.minStart ?? 0);
  const maxEnd = Math.min(duration, input.maxEnd ?? duration);
  const before = tool.scores(start, end);

  const rot = chooseRotation(tool, start, end, minStart - start, maxEnd - end, cfg);
  const s1 = start + rot.shift;
  let e1 = end + rot.shift;

  const al = alignEnd(samples, sampleRate, s1, e1, cfg);
  const e2 = clamp(e1 + al.align, s1 + 0.05, maxEnd);
  const align = e2 - e1;
  e1 = e2;

  const beat = localBeatSeconds(tool, s1);
  const harmony = tool.harmonyAt(e1, s1);
  const fade = chooseFade(samples, sampleRate, e1, s1, harmony, beat, cfg);
  const level = chooseLevel(tool, samples, sampleRate, e1, s1, beat, cfg);

  const after = tool.scores(s1, e1);
  return {
    forStart: start,
    forEnd: end,
    smooth: true,
    shift: rot.shift,
    align,
    loopStart: s1,
    loopEnd: e1,
    jumps: [
      {
        from: e1,
        to: s1,
        fadeMs: fade.fadeMs,
        ...(level !== 0 ? { levelDb: level, rampSeconds: beat } : {}),
      },
    ],
    before,
    after,
    bridge: null,
  };
}

/** A plan that leaves the seam as it is (smoothing off): the plain jump from the loop end to its start. */
export function plainSeamPlan(tool: SeamAnalyzer, start: number, end: number): SeamPlan {
  const scores = tool.scores(start, end);
  return {
    forStart: start,
    forEnd: end,
    smooth: false,
    shift: 0,
    align: 0,
    loopStart: start,
    loopEnd: end,
    jumps: [{ from: end, to: start }],
    before: scores,
    after: scores,
    bridge: null,
  };
}
