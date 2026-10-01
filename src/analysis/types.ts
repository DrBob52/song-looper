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
