import { ANALYSIS_CONFIG } from './config';
import type { BeatFeatures } from './features';
import { loopHarmony } from './harmony';
import type { HarmonyModel } from './harmony';
import type { SelfSimilarity } from './ssm';
import type { CandidateComponents, LoopCandidate, Section } from './types';

/** Widen the `as const` literals of the config so callers (and tests) can pass other numbers. */
type Widen<T> = {
  -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends readonly number[] ? readonly number[] : T[K] extends object ? Widen<T[K]> : T[K];
};
type CandidateConfig = Widen<typeof ANALYSIS_CONFIG.candidates>;

export interface CandidateInput {
  ssm: SelfSimilarity;
  features: BeatFeatures;
  beats: number[];
  /** Beat indices that start a bar, in order (an arithmetic progression with step beatsPerBar). */
  barBeats: number[];
  beatsPerBar: number;
  sections: Section[];
  /** Beat indices that start a section. */
  boundaries: number[];
  duration: number;
  /** Harmonic transition model. Without one the seam score is the context match alone. */
  harmony?: HarmonyModel | null;
  cfg?: CandidateConfig;
}

/** Mean of S[a + j][b + j] for j in [-seamBeats, +seamBeats): how much the music around b matches the music around a. */
export function seamScore(ssm: SelfSimilarity, a: number, b: number, seamBeats: number): number {
  const { S, n } = ssm;
  let sum = 0;
  let count = 0;
  for (let j = -seamBeats; j < seamBeats; j++) {
    const ia = a + j;
    const ib = b + j;
    if (ia < 0 || ib < 0 || ia >= n || ib >= n) continue;
    sum += S[ia * n + ib]!;
    count++;
  }
  if (count === 0) return 0;
  // Missing context (a loop at the very start of the song) counts against the seam a little.
  const coverage = count / (2 * seamBeats);
  return Math.max(0, Math.min(1, (sum / count) * (0.5 + 0.5 * coverage)));
}

/** Mean of S[ia][ib] over the pairs `pairs(j)` that lie inside the matrix, with a small penalty for missing context. */
function diagonalMean(ssm: SelfSimilarity, beats: number, pairs: (j: number) => [number, number]): number {
  const { S, n } = ssm;
  let sum = 0;
  let count = 0;
  for (let j = 0; j < beats; j++) {
    const [ia, ib] = pairs(j);
    if (ia < 0 || ib < 0 || ia >= n || ib >= n) continue;
    sum += S[ia * n + ib]!;
    count++;
  }
  if (count === 0) return 0;
  return Math.max(0, Math.min(1, (sum / count) * (0.5 + 0.5 * (count / beats))));
}

/**
 * SPEC-seams.md 6. How well the music around a matches the music around b, on either side:
 *
 *   max( mean S[a-1-j][b-1-j]  (the lead-ins match),  mean S[a+j][b+j]  (the continuations match) )  for j in 0..3
 *
 * The old seam score demanded both sides. That penalised looping one whole section (a chorus that is followed
 * by a verse) even when the chord change back to the start occurs elsewhere in the song.
 */
export function contextMatch(ssm: SelfSimilarity, a: number, b: number, beats: number = ANALYSIS_CONFIG.candidates.contextBeats): number {
  const lead = diagonalMean(ssm, beats, (j) => [a - 1 - j, b - 1 - j]);
  const cont = diagonalMean(ssm, beats, (j) => [a + j, b + j]);
  return Math.max(lead, cont);
}

export function structureScore(
  a: number,
  b: number,
  boundaries: ReadonlySet<number>,
  cfg: Pick<CandidateConfig, 'wholeSegmentBonus'> = ANALYSIS_CONFIG.candidates,
): number {
  const hasA = boundaries.has(a);
  const hasB = boundaries.has(b);
  const base = hasA && hasB ? 1 : hasA || hasB ? 0.5 : 0;
  // [a, b) is exactly whole segments iff both edges are boundaries of the segmentation.
  const whole = hasA && hasB;
  return Math.min(1, base + (whole ? cfg.wholeSegmentBonus : 0));
}

export function energyContinuity(loudness: Float32Array, a: number, b: number, rangeDb: number): number {
  const d = Math.abs(loudness[b - 1]! - loudness[a]!);
  return 1 - Math.min(1, d / rangeDb);
}

export function lengthPreference(bars: number, cfg: CandidateConfig = ANALYSIS_CONFIG.candidates): number {
  if ((cfg.lengthPreferred as readonly number[]).includes(bars)) return cfg.lengthPreferredScore;
  return bars % 2 === 0 ? cfg.lengthEvenScore : cfg.lengthOddScore;
}

export function starsFor(score: number, cfg: CandidateConfig = ANALYSIS_CONFIG.candidates): number {
  let stars = 1;
  for (const t of cfg.starThresholds) if (score >= t) stars++;
  return Math.min(5, stars);
}

/** Intersection over union of two beat ranges. */
function iou(a0: number, a1: number, b0: number, b1: number): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = a1 - a0 + (b1 - b0) - inter;
  return union > 0 ? inter / union : 0;
}

/** How many times a run of section labels occurs (without overlapping) in the song's label list. */
export function countRuns(labels: string[], run: string[]): number {
  let count = 0;
  for (let i = 0; i + run.length <= labels.length; ) {
    if (run.every((l, k) => labels[i + k] === l)) {
      count++;
      i += run.length;
    } else i++;
  }
  return count;
}

function describe(
  c: Pick<LoopCandidate, 'startBeat' | 'endBeat' | 'components'>,
  sections: Section[],
  boundaries: ReadonlySet<number>,
): string {
  const parts = [`Seam match ${Math.round(c.components.seam * 100)}%`];
  const h = c.components.harmony;
  if (h !== undefined) {
    if (h >= ANALYSIS_CONFIG.harmony.good) parts.push('chords lead back cleanly');
    else if (h < ANALYSIS_CONFIG.harmony.poor) parts.push("chord change at the seam isn't in the song");
  }
  const hasA = boundaries.has(c.startBeat);
  const hasB = boundaries.has(c.endBeat);
  const labels = sections.map((s) => s.label);
  if (hasA && hasB) {
    const covered = sections.filter((s) => s.startBeat >= c.startBeat && s.endBeat <= c.endBeat);
    const run = covered.map((s) => s.label);
    if (run.length === 1) parts.push(`full section ${run[0]}`);
    else if (run.length > 1 && run.length <= 4) parts.push(`sections ${run.join('+')}`);
    else if (run.length > 4) parts.push(`${run.length} whole sections`);
    else parts.push('starts and ends on section boundaries');
    if (run.length > 0) {
      const times = countRuns(labels, run);
      if (times >= 2) parts.push(`repeats ${times}x in song`);
    }
  } else if (hasA) parts.push('starts on a section boundary');
  else if (hasB) parts.push('ends on a section boundary');
  else if (c.components.energy >= 0.9) parts.push('steady level');
  return parts.join(', ');
}

export interface LoopScoreContext {
  ssm: SelfSimilarity;
  features: Pick<BeatFeatures, 'loudness'>;
  boundaries: ReadonlySet<number>;
  harmony?: HarmonyModel | null;
  cfg?: CandidateConfig;
}

export interface LoopScore {
  score: number;
  components: CandidateComponents;
}

/** How well the jump from beat b - 1 back to beat a sounds: the context match, the harmony and their weighted mean. */
export function seamOfLoop(ctx: LoopScoreContext, a: number, b: number): { seam: number; contextMatch: number; harmony?: number } {
  const cfg = ctx.cfg ?? ANALYSIS_CONFIG.candidates;
  const context = contextMatch(ctx.ssm, a, b, cfg.contextBeats);
  const harmony = ctx.harmony ? loopHarmony(ctx.harmony, a, b) : undefined;
  const seam =
    harmony === undefined ? context : cfg.seamContextWeight * context + cfg.seamHarmonyWeight * harmony;
  return harmony === undefined ? { seam, contextMatch: context } : { seam, contextMatch: context, harmony };
}

/** The candidate score of the beat range [a, b) (a < b, whole bars or not): seam, structure, energy, length. */
export function scoreLoop(ctx: LoopScoreContext, a: number, b: number, beatsPerBar: number): LoopScore {
  const cfg = ctx.cfg ?? ANALYSIS_CONFIG.candidates;
  const w = cfg.weights;
  const { seam, contextMatch: context, harmony } = seamOfLoop(ctx, a, b);
  const structure = structureScore(a, b, ctx.boundaries, cfg);
  const energy = energyContinuity(ctx.features.loudness, a, b, cfg.energyDbRange);
  const length = lengthPreference(Math.round((b - a) / beatsPerBar), cfg);
  const score = w.seam * seam + w.structure * structure + w.energy * energy + w.length * length;
  const components: CandidateComponents = { seam, structure, energy, length, contextMatch: context };
  if (harmony !== undefined) components.harmony = harmony;
  return { score, components };
}

/**
 * Score every bar-aligned (a, b) pair (2 to 32 bars, at least 4 s, at most half the song) and return the
 * best non-overlapping ones, best first.
 */
export function findCandidates(input: CandidateInput): LoopCandidate[] {
  const cfg = input.cfg ?? ANALYSIS_CONFIG.candidates;
  const { ssm, features, beats, barBeats, beatsPerBar, sections, duration } = input;
  const boundaries = new Set(input.boundaries);
  const ctx: LoopScoreContext = { ssm, features, boundaries, harmony: input.harmony, cfg };
  const all: LoopCandidate[] = [];

  for (let ia = 0; ia < barBeats.length; ia++) {
    const a = barBeats[ia]!;
    for (let bars = cfg.minBars; bars <= cfg.maxBars; bars++) {
      const b = a + bars * beatsPerBar;
      if (b > beats.length - 1) break;
      const seconds = beats[b]! - beats[a]!;
      if (seconds > cfg.maxSongFraction * duration) break;
      if (seconds < cfg.minSeconds) continue;
      const { score, components } = scoreLoop(ctx, a, b, beatsPerBar);
      all.push({
        start: beats[a]!,
        end: beats[b]!,
        startBeat: a,
        endBeat: b,
        bars,
        score,
        components,
        reason: describe({ startBeat: a, endBeat: b, components }, sections, boundaries),
        stars: starsFor(score, cfg),
      });
    }
  }

  all.sort((x, y) => y.score - x.score || x.startBeat - y.startBeat);
  const kept: LoopCandidate[] = [];
  for (const c of all) {
    if (kept.some((k) => iou(k.startBeat, k.endBeat, c.startBeat, c.endBeat) > cfg.nmsOverlap)) continue;
    kept.push(c);
    if (kept.length >= cfg.maxCandidates) break;
  }
  return kept;
}
