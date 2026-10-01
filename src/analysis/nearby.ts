import { scoreLoop } from './candidates';
import type { LoopScoreContext } from './candidates';
import { ANALYSIS_CONFIG } from './config';
import { loopHarmony } from './harmony';
import type { HarmonyModel } from './harmony';
import type { NearbyLoop } from './types';

type NearbyConfig = { [K in keyof typeof ANALYSIS_CONFIG.nearby]: number };

export interface NearbyInput {
  harmony: HarmonyModel;
  /** Everything the loop score needs for the tie-break. */
  score: LoopScoreContext;
  beats: readonly number[];
  beatsPerBar: number;
  /** The loop's beats [a, b) and its current harmony. */
  a: number;
  b: number;
  currentHarmony: number;
  /** The loop may not grow into its neighbours or out of the song: its edges stay within [minStart, maxEnd] seconds. */
  minStart: number;
  maxEnd: number;
}

/**
 * SPEC-seams.md 4: a loop near this one (start within a bar, end within two bars, a whole number of bars long) whose
 * chord change from its last beat back to its first is one the song makes. Maximises harmony, the loop score breaks
 * ties. Null unless the loop's harmony is poor and the best neighbour is clearly cleaner.
 */
export function findNearbyLoop(input: NearbyInput, cfg: NearbyConfig = ANALYSIS_CONFIG.nearby): NearbyLoop | null {
  const { harmony, beats, beatsPerBar: bpb, a, b } = input;
  if (input.currentHarmony >= cfg.under || bpb < 1 || beats.length < 2) return null;
  let best: { loop: NearbyLoop; h: number } | null = null;
  for (let a2 = a - cfg.startBars * bpb; a2 <= a + cfg.startBars * bpb; a2++) {
    if (a2 < 0 || beats[a2]! < input.minStart - 1e-6) continue;
    for (let b2 = b - cfg.endBars * bpb; b2 <= b + cfg.endBars * bpb; b2++) {
      if (b2 <= a2 || b2 >= beats.length || (b2 - a2) % bpb !== 0) continue;
      if (a2 === a && b2 === b) continue;
      if (beats[b2]! > input.maxEnd + 1e-6) continue;
      const h = loopHarmony(harmony, a2, b2);
      if (best && h < best.h - cfg.tie) continue;
      const { score } = scoreLoop(input.score, a2, b2, bpb);
      const loop: NearbyLoop = {
        start: beats[a2]!,
        end: beats[b2]!,
        startBeat: a2,
        endBeat: b2,
        bars: (b2 - a2) / bpb,
        harmony: h,
        score,
      };
      if (!best || h > best.h + cfg.tie || (Math.abs(h - best.h) <= cfg.tie && score > best.loop.score)) best = { loop, h };
    }
  }
  if (!best) return null;
  if (best.h < cfg.minHarmony || best.h < input.currentHarmony + cfg.minGain) return null;
  return best.loop;
}
