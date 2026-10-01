import type { FineOnset } from './beats';
import { ANALYSIS_CONFIG } from './config';
import type { FrameData } from './features';
import { harmonyScore } from './harmony';
import type { HarmonyModel } from './harmony';
import type { SeamChip, SeamScores } from './types';

type SeamConfig = typeof ANALYSIS_CONFIG.seam;

/** Index of the beat time nearest to `t` (beats ascending, non-empty). */
export function nearestBeat(beats: readonly number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(beats[lo - 1]! - t) <= Math.abs(beats[lo]! - t)) return lo - 1;
  return lo;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Combine transient, spectral and harmony scores into one quality (harmony missing: the other two share its weight). */
export function seamQuality(
  s: Pick<SeamScores, 'transient' | 'spectral' | 'harmony'>,
  cfg: Pick<SeamConfig, 'quality'> = ANALYSIS_CONFIG.seam,
): number {
  const w = cfg.quality;
  let sum = w.transient * s.transient + w.spectral * s.spectral;
  let weight = w.transient + w.spectral;
  if (s.harmony !== null) {
    sum += w.harmony * s.harmony;
    weight += w.harmony;
  }
  return weight > 0 ? sum / weight : 0;
}

export function chipFor(quality: number, cfg: Pick<SeamConfig, 'chip'> = ANALYSIS_CONFIG.seam): SeamChip {
  if (quality >= cfg.chip.clean) return 'clean';
  if (quality >= cfg.chip.ok) return 'ok';
  return 'rough';
}

/** What the seam analysis reads from the analysis session. */
export interface SeamInputs {
  duration: number;
  frames: FrameData;
  fine: FineOnset;
  beats: readonly number[];
  beatsPerBar: number;
  /** Beat index of the first downbeat. */
  barPhase: number;
  /** A steady beat was found, so beats, bars and harmony mean something. */
  hasGrid: boolean;
  harmony: HarmonyModel | null;
}

/**
 * Scores a seam (a jump from time `end`, the last moment played, back to time `start`): does it land before a
 * hit, does the spectrum carry across it the way the song's own does, and is the chord change one the song makes.
 * Expensive tables (typical spectral change per bar position, the song's beat-onset strength) are built on first use.
 */
export class SeamAnalyzer {
  private typicalByBucket: Float32Array | null = null;
  private levels: Float32Array | null = null;
  private typicalAll = 0;
  private hitRef = 0;
  private readonly bands: number;
  private readonly buckets: number;

  constructor(
    readonly inputs: SeamInputs,
    private cfg: SeamConfig = ANALYSIS_CONFIG.seam,
  ) {
    this.bands = inputs.frames.logMel.length / Math.max(1, inputs.frames.frames);
    this.buckets = Math.max(1, inputs.beatsPerBar) * cfg.spectral.bucketsPerBeat;
  }

  get hasGrid(): boolean {
    return this.inputs.hasGrid && this.inputs.beats.length >= 2;
  }

  // ---- bar position -------------------------------------------------------------

  /**
   * Bucket of time `t` within its bar (`bucketsPerBeat` per beat); 0 without a beat grid. Times before the first
   * beat or after the last extend the grid by the nearest beat interval.
   */
  barBucket(t: number): number {
    if (!this.hasGrid) return 0;
    const { beats, beatsPerBar, barPhase } = this.inputs;
    let i = nearestBeat(beats, t);
    if (beats[i]! > t) i -= 1;
    i = Math.max(0, Math.min(beats.length - 2, i));
    const frac = (t - beats[i]!) / Math.max(1e-6, beats[i + 1]! - beats[i]!);
    const pos = (((i - barPhase + frac) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    return Math.min(this.buckets - 1, Math.floor(pos * this.cfg.spectral.bucketsPerBeat));
  }

  // ---- transient cover ----------------------------------------------------------

  private flux(fromS: number, toS: number): number {
    const { flux, dt } = this.inputs.fine;
    const a = Math.max(0, Math.ceil(fromS / dt));
    const b = Math.min(flux.length - 1, Math.floor(toS / dt));
    let m = 0;
    for (let i = a; i <= b; i++) if (flux[i]! > m) m = flux[i]!;
    return m;
  }

  /** The song's usual strength of a beat's onset on the fine curve (what "a strong hit" means here). */
  private hitReference(): number {
    if (this.hitRef > 0) return this.hitRef;
    const { beats } = this.inputs;
    const peaks: number[] = [];
    if (this.hasGrid) for (const b of beats) peaks.push(this.flux(b - 0.06, b + 0.06));
    else {
      const { flux } = this.inputs.fine;
      for (let i = 0; i < flux.length; i += 4) peaks.push(flux[i]!);
    }
    const ref = quantile(peaks.filter((v) => v > 0), this.hasGrid ? this.cfg.transient.refPercentile : 0.95);
    this.hitRef = Math.max(ref, 1e-6);
    return this.hitRef;
  }

  /** 1 when a typical strong hit follows within a few tens of ms, lower when none does or the seam slices through an attack. */
  transientCover(t: number): number {
    const c = this.cfg.transient;
    const ref = this.hitReference();
    const ahead = this.flux(t + c.aheadMs[0] / 1000, t + c.aheadMs[1] / 1000) / ref;
    const behind = this.flux(t - c.behindMs[0] / 1000, t + c.behindMs[1] / 1000) / ref;
    return Math.max(0, Math.min(1, Math.min(1, ahead) - c.behindWeight * Math.min(1, behind)));
  }

  /** 1 when a typical strong hit lies anywhere near `t` (a little before to a little after): which positions are worth a closer look. */
  transientNear(t: number): number {
    const [before, after] = this.cfg.transient.nearMs;
    return Math.min(1, this.flux(t - before / 1000, t + after / 1000) / this.hitReference());
  }

  // ---- spectral continuity ------------------------------------------------------

  private frameAt(t: number): number {
    const { frames, frameRate } = this.inputs.frames;
    return Math.max(0, Math.min(frames - 1, Math.round(t * frameRate)));
  }

  /** Mean absolute change of the log-mel spectrum (dB per band) between two frames. */
  private frameDistance(f1: number, f2: number): number {
    const { logMel, frames } = this.inputs.frames;
    const a = Math.max(0, Math.min(frames - 1, f1)) * this.bands;
    const b = Math.max(0, Math.min(frames - 1, f2)) * this.bands;
    let s = 0;
    for (let k = 0; k < this.bands; k++) s += Math.abs(logMel[a + k]! - logMel[b + k]!);
    return s / this.bands;
  }

  private buildTypical(): void {
    const { frames, frameRate } = this.inputs.frames;
    const off = this.cfg.spectral.frameOffset;
    const perBucket: number[][] = Array.from({ length: this.buckets }, () => []);
    const all: number[] = [];
    for (let f = off; f < frames - off; f++) {
      const d = this.frameDistance(f - off, f + off);
      all.push(d);
      if (this.hasGrid) {
        perBucket[this.barBucket(f / frameRate)]!.push(d);
      }
    }
    this.typicalAll = quantile(all, 0.5);
    const out = new Float32Array(this.buckets);
    const { minSamples, maxSpread } = this.cfg.spectral;
    for (let k = 0; k < this.buckets; k++) {
      // pool the neighbouring positions (the bar is circular) until there are enough frames to take a median of
      let pooled: number[] = [];
      for (let spread = 0; spread <= maxSpread; spread++) {
        pooled = [];
        for (let d = -spread; d <= spread; d++) pooled.push(...perBucket[(((k + d) % this.buckets) + this.buckets) % this.buckets]!);
        if (pooled.length >= minSamples) break;
      }
      out[k] = pooled.length >= 3 ? quantile(pooled, 0.5) : this.typicalAll;
    }
    this.typicalByBucket = out;
  }

  /** The song's typical spectral change across a cut at the bar position of time `t`. */
  typicalFlux(t: number): number {
    if (!this.typicalByBucket) this.buildTypical();
    const v = this.hasGrid ? this.typicalByBucket![this.barBucket(t)]! : this.typicalAll;
    return Math.max(v, this.cfg.spectral.minTypicalDb);
  }

  /** The spectral change across the seam, in dB per band: last frame before `end` against the first frame after `start`. */
  seamFlux(end: number, start: number): number {
    const off = this.cfg.spectral.frameOffset;
    return this.frameDistance(this.frameAt(end) - off, this.frameAt(start) + off);
  }

  /** 1 - min(1, seamFlux / (2 * typicalFlux)): a seam as smooth as the song's own cuts scores 0.5, a seamless one 1. */
  spectralContinuity(end: number, start: number): number {
    return 1 - Math.min(1, this.seamFlux(end, start) / (2 * this.typicalFlux(start)));
  }

  // ---- level --------------------------------------------------------------------

  /** Mean-square level of each beat in dB (from the analysis frames). */
  beatLevels(): Float32Array {
    if (this.levels) return this.levels;
    const { beats } = this.inputs;
    const { energy, frameRate, frames } = this.inputs.frames;
    const out = new Float32Array(beats.length);
    for (let i = 0; i < beats.length; i++) {
      const t1 = i + 1 < beats.length ? beats[i + 1]! : beats[i]! + (i > 0 ? beats[i]! - beats[i - 1]! : 0.5);
      const f0 = Math.max(0, Math.min(frames - 1, Math.round(beats[i]! * frameRate)));
      const f1 = Math.max(f0 + 1, Math.min(frames, Math.round(t1 * frameRate)));
      let e = 0;
      for (let f = f0; f < f1; f++) e += energy[f]!;
      out[i] = 10 * Math.log10(e / (f1 - f0) + 1e-12);
    }
    this.levels = out;
    return out;
  }

  /**
   * How much louder (dB) the song itself makes the beat at the bar position of `y` than the beat at the position of
   * `x`, going forward from `x` (the median over the whole song): its accent pattern. A seam from beat `x` to beat `y`
   * has that step for free; only the excess over it is a level jump. 0 without a beat grid.
   */
  accentStep(x: number, y: number): number {
    if (!this.hasGrid) return 0;
    const bpb = Math.max(1, this.inputs.beatsPerBar);
    const gap = (((y - x) % bpb) + bpb) % bpb || bpb; // beats from x to the next beat at y's bar position
    const lv = this.beatLevels();
    const steps: number[] = [];
    for (let i = ((x % bpb) + bpb) % bpb; i + gap < lv.length; i += bpb) steps.push(lv[i + gap]! - lv[i]!);
    if (steps.length < 3) return 0;
    steps.sort((p, q) => p - q);
    return steps[steps.length >> 1]!;
  }

  // ---- harmony ------------------------------------------------------------------

  /** Beats the seam goes between: the last beat played before `end`, and the beat at `start` (nearest beats). */
  seamBeats(end: number, start: number): { x: number; y: number } | null {
    if (!this.hasGrid) return null;
    const { beats } = this.inputs;
    const b = nearestBeat(beats, end);
    const a = nearestBeat(beats, start);
    return { x: Math.max(0, b - 1), y: a };
  }

  harmonyAt(end: number, start: number): number | null {
    const m = this.inputs.harmony;
    const pair = this.seamBeats(end, start);
    if (!m || !pair) return null;
    return harmonyScore(m, pair.x, pair.y);
  }

  // ---- everything ---------------------------------------------------------------

  scores(start: number, end: number): SeamScores {
    const transient = this.transientCover(start);
    const spectral = this.spectralContinuity(end, start);
    const harmony = this.harmonyAt(end, start);
    return { transient, spectral, harmony, quality: seamQuality({ transient, spectral, harmony }, this.cfg) };
  }
}
