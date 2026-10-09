import { energyContinuity, seamOfLoop, structureScore } from './candidates';
import type { CandidateInput, LoopScoreContext } from './candidates';
import { ANALYSIS_CONFIG } from './config';
import type { Section, WholeSongComponents, WholeSongOption } from './types';

type Widen<T> = {
  -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends readonly number[] ? readonly number[] : T[K] extends object ? Widen<T[K]> : T[K];
};
type WholeSongConfig = Widen<typeof ANALYSIS_CONFIG.wholeSong>;

export interface WholeSongInput extends CandidateInput {
  /** The song has a steady beat; without one there is nothing to tie together. */
  steadyBeat?: boolean;
  wholeSongCfg?: WholeSongConfig;
}

function starsFor(score: number, thresholds: readonly number[]): number {
  let stars = 1;
  for (const t of thresholds) if (score >= t) stars++;
  return Math.min(5, stars);
}

function sectionAt(sections: Section[], beat: number): Section | undefined {
  return sections.find((s) => s.startBeat <= beat && beat < s.endBeat);
}

function describe(
  o: { startBeat: number; endBeat: number; components: WholeSongComponents },
  sections: Section[],
  boundaries: ReadonlySet<number>,
): string {
  const h = ANALYSIS_CONFIG.harmony;
  const c = o.components;
  const parts: string[] = [];
  if (c.harmony !== undefined && c.harmony >= h.good) parts.push('Chords lead back cleanly');
  else if (c.harmony !== undefined && c.harmony < h.poor) parts.push("The chord change at the jump isn't in the song");
  else parts.push(`Seam match ${Math.round(c.seam * 100)}%`);
  const hasA = boundaries.has(o.startBeat);
  const hasB = boundaries.has(o.endBeat);
  const from = sectionAt(sections, o.endBeat - 1);
  const to = sectionAt(sections, o.startBeat);
  if (hasA && hasB) {
    parts.push(
      from && to
        ? `jumps from the end of section ${from.label} back to the start of section ${to.label}`
        : 'jumps between section boundaries',
    );
  } else if (hasA) parts.push('starts on a section boundary');
  else if (hasB) parts.push('ends on a section boundary');
  parts.push(`keeps ${Math.round(c.coverage * 100)}% of the song`);
  return parts.join(', ');
}

/**
 * SPEC-v1.4.md 2: ways to loop a whole song by tying its end back to its beginning. The start is a bar start just
 * after the intro and the end a bar start just before the outro, so that each play is almost the full song. Scored
 * with the suggestions' own seam (context match and harmony), structure and energy terms plus the share of the song
 * kept; the best few that are not near-duplicates are returned, best first. Empty for a song that is too short, has
 * no steady beat, or has no pair of bar lines that keeps enough of it.
 */
export function findWholeSongLoops(input: WholeSongInput): WholeSongOption[] {
  const cfg = input.wholeSongCfg ?? ANALYSIS_CONFIG.wholeSong;
  const { ssm, features, beats, barBeats, beatsPerBar, sections, duration } = input;
  if (input.steadyBeat === false) return [];
  if (duration < ANALYSIS_CONFIG.limits.minSongSeconds || beats.length < ANALYSIS_CONFIG.limits.minBeats) return [];
  const startWindow = Math.min(cfg.startWindowFraction * duration, cfg.startWindowSeconds);
  const endWindow = Math.min(cfg.endWindowFraction * duration, cfg.endWindowSeconds);
  const starts = barBeats.filter((a) => beats[a]! <= startWindow);
  const ends = barBeats.filter((b) => b < beats.length && beats[b]! >= duration - endWindow);
  const boundaries = new Set(input.boundaries);
  const ctx: LoopScoreContext = { ssm, features, boundaries, harmony: input.harmony };
  const w = cfg.weights;
  const all: WholeSongOption[] = [];
  for (const a of starts) {
    for (const b of ends) {
      if (b <= a) continue;
      const coverage = (beats[b]! - beats[a]!) / duration;
      if (coverage < cfg.minCoverage) continue;
      const { seam, contextMatch, harmony } = seamOfLoop(ctx, a, b);
      const structure = structureScore(a, b, boundaries);
      const energy = energyContinuity(features.loudness, a, b, ANALYSIS_CONFIG.candidates.energyDbRange);
      const score = w.seam * seam + w.structure * structure + w.energy * energy + w.coverage * coverage;
      const components: WholeSongComponents = { seam, structure, energy, coverage, contextMatch };
      if (harmony !== undefined) components.harmony = harmony;
      all.push({
        start: beats[a]!,
        end: beats[b]!,
        startBeat: a,
        endBeat: b,
        bars: (b - a) / beatsPerBar,
        score,
        components,
        skipsIntro: beats[a]!,
        skipsOutro: Math.max(0, duration - beats[b]!),
        reason: describe({ startBeat: a, endBeat: b, components }, sections, boundaries),
        stars: starsFor(score, cfg.starThresholds),
      });
    }
  }
  all.sort((x, y) => y.score - x.score || x.startBeat - y.startBeat || x.endBeat - y.endBeat);
  const near = cfg.nmsBars * beatsPerBar;
  const kept: WholeSongOption[] = [];
  for (const o of all) {
    if (kept.some((k) => Math.abs(k.startBeat - o.startBeat) <= near && Math.abs(k.endBeat - o.endBeat) <= near)) continue;
    kept.push(o);
    if (kept.length >= cfg.maxOptions) break;
  }
  return kept;
}
