import { ANALYSIS_CONFIG } from './config';

/** The harmony tunables (widened from the `as const` config so tests and callers can override them). */
export type HarmonyConfig = { -readonly [K in keyof typeof ANALYSIS_CONFIG.harmony]: number };

/**
 * Harmonic transition model (SPEC-seams.md section 2).
 *
 * The song itself shows which chord changes sound natural. A jump from beat `x` (the last beat played) to
 * beat `y` (the next beat played) is natural when the song somewhere plays a few beats like the ones that
 * lead up to `x`, followed by a few beats like the ones that start at `y`.
 */

/** Cosine similarity of per-beat chroma vectors, n x n (no delay embedding). */
export interface ChromaSimilarity {
  C: Float32Array;
  n: number;
}

/** The chroma similarity plus this song's own normalisation (section 2.3). */
export interface HarmonyModel extends ChromaSimilarity {
  windowBeats: number;
  /** Beats per bar (places closer than this count as the same match). */
  beatsPerBar: number;
  /** Median and 95th percentile of the evidence of random beat pairs. */
  p50: number;
  p95: number;
  /** True when the song is harmonically static (every seam scores 1). */
  isStatic: boolean;
  cfg: HarmonyConfig;
  /** Scratch space for the evidence search. */
  scratch: Float32Array;
}

export interface Evidence {
  /** Mean of the best matches (1 for a natural continuation). */
  value: number;
  /** Beat where the best match starts (the song plays "like x, then like y" from here), or -1. */
  at: number;
}

/** C[i][j] = cosine similarity of the chroma of beats i and j. Chroma rows are expected to be L2-normalised. */
export function chromaSimilarity(chroma: Float32Array, n: number, dims = 12): ChromaSimilarity {
  const norm = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < dims; k++) s += chroma[i * dims + k]! ** 2;
    s = Math.sqrt(s);
    // Silent beats stay all-zero: similar to nothing.
    if (s > 1e-9) for (let k = 0; k < dims; k++) norm[i * dims + k] = chroma[i * dims + k]! / s;
  }
  const C = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const ri = i * dims;
    for (let j = i; j < n; j++) {
      const rj = j * dims;
      let dot = 0;
      for (let k = 0; k < dims; k++) dot += norm[ri + k]! * norm[rj + k]!;
      if (dot < 0) dot = 0;
      C[i * n + j] = dot;
      C[j * n + i] = dot;
    }
  }
  return { C, n };
}

/** Small deterministic PRNG (mulberry32), so the per-song normalisation is reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Transition evidence for a seam from beat `x` to beat `y` (section 2.2):
 *
 *   max over t of min( C[x-w+1+k][t-w+k] for k in 0..w-1,     // the lead-in matches
 *                      C[y+k][t+k]       for k in 0..w-1 )    // the continuation matches
 *
 * i.e. some place `t` in the song has a lead-in like the last `w` beats played and a continuation like the
 * first `w` beats of the return. Windows that run off either end of the song are skipped; the trivial match
 * `t = y` is excluded unless the seam is the natural continuation (`y = x + 1`, evidence 1); the result is
 * the mean of the best `topMatches` values of `t` that are at least one bar apart (with the corroboration
 * discount described in the config for near-exact matches).
 */
export function transitionEvidence(m: ChromaSimilarity & Pick<HarmonyModel, 'windowBeats' | 'beatsPerBar' | 'cfg' | 'scratch'>, x: number, y: number): Evidence {
  const { C, n, windowBeats: w, scratch } = m;
  if (y === x + 1) return { value: 1, at: y };
  const tMin = w;
  const tMax = n - w;
  if (tMax < tMin) return { value: 0, at: -1 };
  const xs = x - w + 1;
  let n1 = -1;
  let best1 = -1;
  scratch.fill(-1, 0, n);
  for (let t = tMin; t <= tMax; t++) {
    if (t === y) continue;
    let v = 1;
    for (let k = 0; k < w; k++) {
      const xi = Math.min(n - 1, Math.max(0, xs + k));
      const yi = Math.min(n - 1, Math.max(0, y + k));
      const a = C[xi * n + (t - w + k)]!;
      if (a < v) v = a;
      const b = C[yi * n + (t + k)]!;
      if (b < v) v = b;
    }
    scratch[t] = v;
    if (v > best1) {
      best1 = v;
      n1 = t;
    }
  }
  if (n1 < 0) return { value: 0, at: -1 };
  // The next best place that is at least one bar away from the best one (and so not a neighbour of it).
  const top = Math.max(1, m.cfg.topMatches);
  const taken = [n1];
  const rest: number[] = [];
  while (taken.length < top) {
    let nt = -1;
    let bt = -1;
    for (let t = tMin; t <= tMax; t++) {
      const v = scratch[t]!;
      if (v <= bt) continue;
      let far = true;
      for (const u of taken) {
        if (Math.abs(t - u) < m.beatsPerBar) {
          far = false;
          break;
        }
      }
      if (far) {
        bt = v;
        nt = t;
      }
    }
    if (nt < 0) break;
    rest.push(bt);
    taken.push(nt);
  }
  if (rest.length === 0) return { value: best1, at: n1 };
  // The backing matches' share is 1/top each, waived as the best match nears an exact repeat.
  const { exactMatch, corroborateBelow } = m.cfg;
  const need = Math.max(0, Math.min(1, (exactMatch - best1) / Math.max(1e-6, exactMatch - corroborateBelow)));
  let value = best1;
  for (const v of rest) value += ((v - best1) * need) / top;
  return { value, at: n1 };
}

/** Build the model: chroma similarity plus the per-song distribution of evidence over random beat pairs. */
export function buildHarmonyModel(
  sim: ChromaSimilarity,
  beatsPerBar: number,
  cfg: HarmonyConfig = ANALYSIS_CONFIG.harmony,
): HarmonyModel {
  const n = sim.n;
  const model: HarmonyModel = {
    ...sim,
    windowBeats: cfg.windowBeats,
    beatsPerBar: Math.max(1, beatsPerBar),
    p50: 0,
    p95: 0,
    isStatic: true,
    cfg,
    scratch: new Float32Array(n),
  };
  calibrate(model);
  return model;
}

/** Re-derive p50/p95 (for example after the bar length changed). */
export function calibrate(model: HarmonyModel, beatsPerBar: number = model.beatsPerBar): void {
  model.beatsPerBar = Math.max(1, beatsPerBar);
  const { n, windowBeats: w, cfg } = model;
  const lo = w - 1; // first x with a full lead-in window
  const hi = n - w; // last y with a full continuation window
  if (hi <= lo + 1) {
    model.p50 = 0;
    model.p95 = 0;
    model.isStatic = true;
    return;
  }
  const rng = makeRng(cfg.sampleSeed);
  const values = new Float64Array(cfg.sampleCount);
  let count = 0;
  for (let tries = 0; count < cfg.sampleCount && tries < cfg.sampleCount * 4; tries++) {
    const x = lo + Math.floor(rng() * (n - lo));
    const y = Math.floor(rng() * (hi + 1));
    if (x >= n || y === x + 1) continue;
    values[count++] = transitionEvidence(model, x, y).value;
  }
  const sorted = values.subarray(0, count).slice().sort();
  model.p50 = quantile(sorted, 0.5);
  model.p95 = quantile(sorted, 0.95);
  model.isStatic = !(model.p95 - model.p50 >= cfg.minSpread);
}

/** Normalise raw evidence to [0, 1] against this song's own distribution (section 2.3). */
export function normalizeEvidence(model: HarmonyModel, evidence: number): number {
  if (model.isStatic) return 1;
  const v = (evidence - model.p50) / (model.p95 - model.p50);
  return Math.max(0, Math.min(1, v));
}

/** Harmony of a seam from beat `x` (last beat played) to beat `y` (next beat played), in [0, 1]. */
export function harmonyScore(model: HarmonyModel, x: number, y: number): number {
  if (model.isStatic || y === x + 1) return 1;
  return normalizeEvidence(model, transitionEvidence(model, x, y).value);
}

/** Harmony of a loop over beats [a, b): the seam goes from its last beat b - 1 back to its first beat a. */
export function loopHarmony(model: HarmonyModel, a: number, b: number): number {
  return harmonyScore(model, b - 1, a);
}
