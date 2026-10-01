import type { SeamPlan } from '../model';

export interface Section {
  start: number;
  end: number;
  label: string;
  hint?: string;
  /** Beat indices of the section edges (into Analysis.beats). */
  startBeat: number;
  endBeat: number;
}

export interface CandidateComponents {
  /** 0.5 * contextMatch + 0.5 * harmony (SPEC-seams.md 6); the context match alone when there is no harmony model. */
  seam: number;
  structure: number;
  energy: number;
  length: number;
  /** How well the music before / after the two edges matches (the better of the two sides). */
  contextMatch: number;
  /** Does the song itself make this chord change? 0 (never) to 1 (yes). */
  harmony?: number;
}

export interface LoopCandidate {
  /** Seconds, on beat times. */
  start: number;
  end: number;
  startBeat: number;
  endBeat: number;
  bars: number;
  score: number;
  components: CandidateComponents;
  reason: string;
  /** 1..5 */
  stars: number;
}

export interface Analysis {
  bpm: number;
  bpmAlt: number;
  /** Beat times in seconds. */
  beats: number[];
  beatsPerBar: number;
  /** Index into `beats` of the first downbeat (0..beatsPerBar-1). */
  barPhase: number;
  sections: Section[];
  candidates: LoopCandidate[];

  // Additions beyond the spec'd shape:
  duration: number;
  /** 0..1 autocorrelation confidence of the tempo estimate. */
  beatConfidence: number;
  /** False when there is no steady beat (snap to a fixed grid, suggestions are rough). */
  steadyBeat: boolean;
  /** The audio is (near-)silent: nothing was analysed. */
  silent: boolean;
  /** Why suggestions were skipped, if they were. */
  skipped?: 'short' | 'silent' | 'no-beats';
  /** Tempo the beat tracker was forced to (by the user), if any. */
  bpmOverride: number | null;
  /** Automatic downbeat guess before any user nudge. */
  autoBarPhase: number;
}

/** Analysis stages reported through `progress`. */
export type AnalysisStage = 'stft' | 'beats' | 'features' | 'ssm' | 'candidates';

export interface AnalysisUpdate {
  beatsPerBar?: number;
  /** Move the downbeat by this many beats (the "Shift bar line" control). */
  phaseShift?: number;
  /** Force the beat tracker to this tempo (BPM); null returns to automatic. */
  bpm?: number | null;
}

/** What a seam sounds like, each in [0, 1] (SPEC-seams.md 3.1 and 3.5). */
export interface SeamScores {
  /** Does the seam land right before a strong hit? */
  transient: number;
  /** How close is the spectrum across the seam to the song's own typical change at that bar position? */
  spectral: number;
  /** Does the song itself make this chord change? null when there is no beat grid to ask. */
  harmony: number | null;
  /** The combination of the three, with harmony weighted up to 0.5. */
  quality: number;
}

export type SeamChip = 'clean' | 'ok' | 'rough';

/** One loop (or suggestion) to report on. Times are seconds on the original song. */
export interface SeamRequest {
  id: string;
  start: number;
  end: number;
  /** Smooth the seam (rotate, align, pick the fade, match levels). Default true. */
  smooth?: boolean;
  /** The loop's edges may move within [minStart, maxEnd] (the free space around it). Default: the whole song. */
  minStart?: number;
  maxEnd?: number;
  /** Look for a bridge (SPEC-seams.md 5): 1 to 4 bars played after the loop end before jumping back. Default off. */
  bridge?: boolean;
}

/** A loop near the user's with a cleaner chord change at its seam (SPEC-seams.md 4). Only ever suggested. */
export interface NearbyLoop {
  /** Seconds, on beat times. */
  start: number;
  end: number;
  startBeat: number;
  endBeat: number;
  bars: number;
  /** Harmony of its seam, and the loop score (the tie-break) it would get as a suggestion. */
  harmony: number;
  score: number;
}

export interface SeamReport {
  id: string;
  /** The points the report was computed for (the app ignores it if the loop has moved since). */
  start: number;
  end: number;
  /** Is there a beat grid (so harmony and bar positions mean something)? */
  hasGrid: boolean;
  /** Harmony of the seam as it will play (after smoothing), or null without a beat grid. */
  harmony: number | null;
  /** Context match of the two edges (SPEC-seams.md 6), or null without a beat grid. */
  contextMatch: number | null;
  /** The seam as it will play. */
  scores: SeamScores;
  /** The raw seam at the loop's own points, for comparison. */
  before: SeamScores;
  chip: SeamChip;
  /** How to play the loop (rotation, alignment, fade, level); null when smoothing is off. */
  plan: SeamPlan | null;
  /** A nearby loop with a cleaner chord change, when this loop's harmony is poor and one exists. */
  nearby: NearbyLoop | null;
  /**
   * The outcome of a bridge search: `found` (the plan plays it), `none` (no natural way back within the limits) or
   * `unneeded` (the direct seam already is about as good as a bridge could make it). Null when none was asked for.
   */
  bridge: 'found' | 'none' | 'unneeded' | null;
}
