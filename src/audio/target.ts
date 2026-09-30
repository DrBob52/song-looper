import { MAX_REPEATS } from '../model';

export interface TargetRegion {
  start: number;
  end: number;
  /** Suggestion score (0..1). Regions without one are weighted by the average of the others. */
  score?: number;
}

export interface TargetResult {
  /** Repeat count per input region (same order). */
  repeats: number[];
  /** Resulting extended length in seconds. */
  total: number;
  /** total - target (negative: shorter than asked). */
  error: number;
}

const total = (lens: number[], reps: number[], duration: number): number =>
  duration + reps.reduce((s, r, i) => s + (r - 1) * lens[i]!, 0);

/**
 * Work out repeat counts that get the extended song close to `target` seconds (spec 5.3).
 *
 * The extra time (target - duration) is split across the regions in proportion to their scores (equally when
 * none has a score), rounded to whole repeats, and then fixed up one repeat at a time on whichever region brings
 * the total closest to the target, until no single change helps. If the target is not longer than the original,
 * every region plays once.
 */
export function solveRepeats(regions: readonly TargetRegion[], duration: number, target: number): TargetResult {
  const n = regions.length;
  const lens = regions.map((r) => Math.max(1e-6, r.end - r.start));
  let reps = new Array<number>(n).fill(1);
  const extra = target - duration;
  if (n === 0 || extra <= 0) {
    const t = total(lens, reps, duration);
    return { repeats: reps, total: t, error: t - target };
  }

  const known = regions.filter((r) => r.score !== undefined && r.score > 0).map((r) => r.score!);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weights = regions.map((r) => (r.score !== undefined && r.score > 0 ? r.score : fallback));
  const wSum = weights.reduce((a, b) => a + b, 0);
  reps = reps.map((_, i) => {
    const share = (extra * weights[i]!) / wSum;
    return Math.min(MAX_REPEATS, 1 + Math.max(0, Math.round(share / lens[i]!)));
  });

  // Fix rounding: add or remove single repeats while that gets closer to the target.
  for (let guard = 0; guard < 10_000; guard++) {
    const current = total(lens, reps, duration);
    const currentErr = Math.abs(current - target);
    let bestErr = currentErr;
    let bestI = -1;
    let bestDelta = 0;
    for (let i = 0; i < n; i++) {
      for (const delta of [1, -1]) {
        const r = reps[i]! + delta;
        if (r < 1 || r > MAX_REPEATS) continue;
        const err = Math.abs(current + delta * lens[i]! - target);
        if (err < bestErr - 1e-9) {
          bestErr = err;
          bestI = i;
          bestDelta = delta;
        }
      }
    }
    if (bestI < 0) break;
    reps[bestI] = reps[bestI]! + bestDelta;
  }
  const t = total(lens, reps, duration);
  return { repeats: reps, total: t, error: t - target };
}
