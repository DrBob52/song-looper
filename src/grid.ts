import { ANALYSIS_CONFIG } from './analysis/config';
import { barBeatIndices } from './analysis/bars';
import type { Analysis } from './analysis/types';

/** The time grid the UI snaps to and draws. */
export interface Grid {
  /** All beat times, seconds, ascending. */
  beats: number[];
  /** Bar-start times, a subset of `beats`. */
  bars: number[];
  /** Beats per bar. */
  beatsPerBar: number;
  /** True when this grid comes from a steady beat (otherwise it is a fixed fallback grid). */
  steady: boolean;
  /** Draw the grid on the waveform. */
  display: boolean;
  /** Typical spacing of beats and of bars, seconds. */
  beatSeconds: number;
  barSeconds: number;
}

export function emptyGrid(): Grid {
  return { beats: [], bars: [], beatsPerBar: 4, steady: false, display: false, beatSeconds: 0.5, barSeconds: 2 };
}

/**
 * Build the grid from an analysis. With no steady beat, snapping falls back to a fixed 0.5 s grid
 * (and nothing is drawn).
 */
export function makeGrid(analysis: Analysis | null, duration: number): Grid {
  if (!analysis || analysis.silent) return emptyGrid();
  if (!analysis.steadyBeat || analysis.beats.length < 2) {
    const step = ANALYSIS_CONFIG.limits.fallbackGridSeconds;
    const times: number[] = [];
    for (let t = 0; t <= duration + 1e-9; t += step) times.push(t);
    return { beats: times, bars: times, beatsPerBar: 1, steady: false, display: false, beatSeconds: step, barSeconds: step };
  }
  const beats = analysis.beats;
  const bars = barBeatIndices(beats.length, analysis.barPhase, analysis.beatsPerBar).map((i) => beats[i]!);
  const beatSeconds = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
  return {
    beats,
    bars: bars.length ? bars : beats,
    beatsPerBar: analysis.beatsPerBar,
    steady: true,
    display: true,
    beatSeconds,
    barSeconds: beatSeconds * analysis.beatsPerBar,
  };
}

/** Nearest value of a sorted array to `t` (binary search). Returns `t` for an empty array. */
export function nearest(sorted: readonly number[], t: number): number {
  const n = sorted.length;
  if (n === 0) return t;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const a = sorted[lo]!;
  const b = lo > 0 ? sorted[lo - 1]! : a;
  return Math.abs(a - t) < Math.abs(b - t) ? a : b;
}

/** Index of the nearest value in a sorted array (or -1 if empty). */
export function nearestIndex(sorted: readonly number[], t: number): number {
  if (sorted.length === 0) return -1;
  const v = nearest(sorted, t);
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Snap a time to bar lines or beat lines. No grid: unchanged. */
export function snapTime(grid: Grid, t: number, toBars: boolean): number {
  const times = toBars ? grid.bars : grid.beats;
  return nearest(times, t);
}

/** Length of [start, end] in bars (by nearest beats), or null if there is no steady grid. */
export function barsBetween(grid: Grid, start: number, end: number): number | null {
  if (!grid.steady || grid.beats.length < 2) return null;
  const a = nearestIndex(grid.beats, start);
  const b = nearestIndex(grid.beats, end);
  const beats = b - a;
  return beats > 0 ? beats / grid.beatsPerBar : null;
}
