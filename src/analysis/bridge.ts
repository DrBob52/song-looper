import { ANALYSIS_CONFIG } from './config';
import { harmonyScore, transitionEvidence } from './harmony';
import type { HarmonyModel } from './harmony';

type BridgeConfig = { [K in keyof typeof ANALYSIS_CONFIG.bridge]: number };

/** One jump of a bridge: leave after beat `from` (the last beat played), land on beat `to` (the next beat played). */
export interface BridgeJump {
  from: number;
  to: number;
  /** Harmony of the jump (the song makes this chord change). */
  harmony: number;
  /** The beat from which the song itself plays "like `from`, then like `to`": where the chord change is found. */
  at: number;
}

export interface BridgePath {
  /** In play order; the last one lands on the loop's first beat. */
  jumps: BridgeJump[];
  /** Beats played beyond the loop's end on every repeat but the last: a whole number of bars (or what completes them). */
  beats: number;
  bars: number;
  /** Beats played before the first jump, straight on from the loop's end (0: it leaves right at the loop's last beat). */
  runBeats: number;
  cost: number;
  worstHarmony: number;
}

export interface BridgeSearch {
  /** `found`, `none` (no natural way back within the limits) or `unneeded` (the direct seam is already about as good as it gets). */
  status: 'found' | 'none' | 'unneeded';
  path: BridgePath | null;
  /** Harmony of the direct seam, for comparison. */
  directHarmony: number;
}

/**
 * SPEC-seams.md 5.1. Shortest path on the beat graph from the loop's last beat (`b - 1`) back to its first (`a`):
 * natural edges `i -> i + 1` cost nothing, jump edges `i -> j` cost `1 - harmony(i -> j)` and only exist where
 * harmony is at least 0.5 and `j` sits at the same bar position as `i + 1`. The path plays 1 to 4 bars beyond the
 * loop and jumps at most twice, the last jump landing on `a`. One jump is the obvious candidate: carry on into the
 * song after the loop end, then jump back at the first bar line where the chord change occurs. Two jumps leave the
 * song's own continuation somewhere earlier, play a stretch from elsewhere and come back.
 */
export function findBridge(
  model: HarmonyModel,
  a: number,
  b: number,
  beatsPerBar: number,
  cfg: BridgeConfig = ANALYSIS_CONFIG.bridge,
): BridgeSearch {
  const n = model.n;
  const bpb = Math.max(1, beatsPerBar);
  const len = b - a;
  const direct = len > 0 ? harmonyScore(model, b - 1, a) : 1;
  const none = (status: BridgeSearch['status']): BridgeSearch => ({ status, path: null, directHarmony: direct });
  if (len < 1 || a < 0 || b > n) return none('none');
  // No jump can beat the direct seam by `minGain` when it is already that good.
  if (direct > 1 - cfg.minGain + 1e-9) return none('unneeded');

  const memo = new Map<number, { h: number; at: number }>();
  const H = (x: number, y: number): { h: number; at: number } => {
    const key = x * n + y;
    let v = memo.get(key);
    if (!v) {
      if (model.isStatic || y === x + 1) v = { h: 1, at: y };
      else {
        const e = transitionEvidence(model, x, y);
        v = { h: harmonyScore(model, x, y), at: e.at };
      }
      memo.set(key, v);
    }
    return v;
  };

  // Lengths outside the loop: whole bars, completing the last bar when the loop is not a whole number of bars long.
  const lengths: number[] = [];
  for (let L = cfg.minBars * bpb; L <= cfg.maxBars * bpb; L++) if ((len + L) % bpb === 0) lengths.push(L);

  let best: BridgePath | null = null;
  const consider = (jumps: BridgeJump[], L: number, run: number): void => {
    const cost =
      jumps.reduce((s, j) => s + (1 - j.harmony), 0) + cfg.jumpPenalty * (jumps.length - 1) + cfg.barPenalty * (L / bpb);
    const worst = Math.min(...jumps.map((j) => j.harmony));
    if (worst < direct + cfg.minGain - 1e-9) return;
    const better =
      !best ||
      cost < best.cost - 1e-9 ||
      (Math.abs(cost - best.cost) <= 1e-9 && (jumps.length < best.jumps.length || (jumps.length === best.jumps.length && L < best.beats)));
    if (better) best = { jumps, beats: L, bars: Math.round(L / bpb), runBeats: run, cost, worstHarmony: worst };
  };

  for (const L of lengths) {
    // One jump: play on to beat b - 1 + L, then jump back to a.
    const last = b - 1 + L;
    if (last + 1 < n) {
      const r = H(last, a);
      if (r.h >= cfg.minHarmony) consider([{ from: last, to: a, harmony: r.h, at: r.at }], L, L);
    }
    if (cfg.maxJumps < 2) continue;
    // Two jumps: run on m0 beats, jump somewhere else (same bar position), play m1 beats there, jump back to a.
    for (let m0 = 0; m0 < L; m0++) {
      const i1 = b - 1 + m0;
      if (i1 + 1 >= n) break;
      const m1 = L - m0;
      for (let j = (i1 + 1) % bpb; j < n; j += bpb) {
        if (j === i1 + 1 || j === a) continue;
        const i2 = j + m1 - 1;
        if (i2 + 1 >= n) break;
        const first = H(i1, j);
        if (first.h < cfg.minHarmony) continue;
        const second = H(i2, a);
        if (second.h < cfg.minHarmony) continue;
        consider(
          [
            { from: i1, to: j, harmony: first.h, at: first.at },
            { from: i2, to: a, harmony: second.h, at: second.at },
          ],
          L,
          m0,
        );
      }
    }
  }
  if (!best) return none('none');
  return { status: 'found', path: best, directHarmony: direct };
}
