import type { SeamScores } from './analysis/types';

/** A time span in seconds. */
export interface Span {
  start: number;
  end: number;
}

/**
 * What the seam smoother decided for one jump of a loop (SPEC-seams.md 3). Times are seconds on the original song.
 * Settings left out mean "no change": the global seam smoothing length, no level ramp.
 */
export interface JumpPlan {
  /** The end of the stretch played before the jump (the last moment heard). */
  from: number;
  /** Where playing resumes. */
  to: number;
  /** Crossfade length in milliseconds. */
  fadeMs?: number;
  /** Gain change (dB) that the last `rampSeconds` before the jump ramp linearly to, so both sides meet at one level. */
  levelDb?: number;
  rampSeconds?: number;
}

/** How a loop with a bridge gets back to its start (SPEC-seams.md 5); the jumps themselves are in `SeamPlan.jumps`. */
export interface BridgeInfo {
  /** Whole bars played after the loop end on every repeat but the last. */
  bars: number;
  /** Seconds those bars add to every repeat but the last. */
  seconds: number;
  /** Where the bridge begins in the song: the loop's end. */
  from: number;
  /** Time in the song at which the song itself makes the chord change that leads back to the loop start. */
  chordChangeAt: number;
  /** The weakest jump of the bridge, as harmony. */
  worstHarmony: number;
  /** Number of jumps (the one back to the start included). */
  jumps: number;
}

/**
 * The seam smoother's decisions for a loop: where both edges move to (rotation), how the end edge is aligned, and
 * per-jump settings (with a bridge: one jump per piece). The loop's own points stay as the user set them; the plan
 * says how to play them, and is only valid for the points it was computed for.
 */
export interface SeamPlan {
  /** The loop points (seconds) this plan was computed for; the plan is ignored once the loop has moved. */
  forStart: number;
  forEnd: number;
  /** Smoothing was on when the plan was made. */
  smooth: boolean;
  /** Both edges moved by this much (rotation, seconds). */
  shift: number;
  /** The end edge moved by this much on top of that (micro-alignment, seconds). */
  align: number;
  /** The loop's own edges after the shift: where the final repeat plays through and leaves. */
  loopStart: number;
  loopEnd: number;
  /** One cycle's jumps: with no bridge the single jump from the loop end back to its start. */
  jumps: JumpPlan[];
  /** Seam scores before and after smoothing. */
  before: SeamScores;
  after: SeamScores;
  bridge?: BridgeInfo | null;
}

/** A user loop region, in seconds on the original song. */
export interface LoopRegion {
  id: string;
  start: number;
  end: number;
  /** 1 means play once (same as the original); up to MAX_REPEATS. */
  repeats: number;
  color: string;
  /** Suggestion score in [0, 1] when the region came from a suggestion. Used to split a target length. */
  score?: number;
  /** Snap edges to bar lines (true, the default) or beats (false) while dragging. */
  snapToBars?: boolean;
  /** Smooth the seam: rotate both edges by up to a beat, align the end, pick the fade and match levels. Default on. */
  smooth?: boolean;
  /** Play a bridge of 1 to 4 bars after the loop end before jumping back (opt-in, default off). */
  bridge?: boolean;
  /** What the seam smoother decided for the loop's current points (see SeamPlan). */
  seam?: SeamPlan;
}

export interface Plan {
  regions: LoopRegion[];
}

export const MAX_REPEATS = 64;
export const MAX_EXTENDED_SECONDS = 60 * 60;

export const REGION_COLORS = [
  '#2563eb',
  '#db2777',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#65a30d',
];
