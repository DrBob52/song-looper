import { ANALYSIS_CONFIG } from './analysis/config';
import type { Cut, Ending, LoopRegion, SeamPlan, Span } from './model';
import { MAX_FADE_SECONDS, REGION_COLORS } from './model';
import { formatClock } from './util/time';

export const MIN_REGION_SECONDS = 0.1;
/** The shortest cut (SPEC-v1.3.md 2.1). */
export const MIN_CUT_SECONDS = 0.05;

/** Anything that occupies a span of the song and blocks others from it: a loop or a cut. */
export type Occupied = Span & { id: string };

export function sortRegions<T extends Span>(regions: readonly T[]): T[] {
  return [...regions].sort((a, b) => a.start - b.start);
}

/** Free spans of the song not covered by any region (optionally ignoring one region). */
export function freeGaps(regions: readonly Occupied[], duration: number, excludeId?: string): Span[] {
  const gaps: Span[] = [];
  let cursor = 0;
  for (const r of sortRegions(regions)) {
    if (r.id === excludeId) continue;
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) gaps.push({ start: cursor, end: duration });
  return gaps;
}

/**
 * Fit a wanted span into free space: clamp it to the free gap it overlaps most. Returns null
 * if it does not overlap any gap or the clamped span is shorter than `minLength`.
 */
export function fitSpan(
  regions: readonly Occupied[],
  span: Span,
  duration: number,
  minLength = MIN_REGION_SECONDS,
  excludeId?: string,
): Span | null {
  const want = { start: Math.max(0, span.start), end: Math.min(duration, span.end) };
  let best: Span | null = null;
  let bestOverlap = 0;
  for (const gap of freeGaps(regions, duration, excludeId)) {
    const overlap = Math.min(want.end, gap.end) - Math.max(want.start, gap.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = { start: Math.max(want.start, gap.start), end: Math.min(want.end, gap.end) };
    }
  }
  if (!best || best.end - best.start < minLength) return null;
  return best;
}

/** The [lo, hi] range a region may occupy without touching its neighbours. */
export function neighbourBounds(regions: readonly Occupied[], id: string, duration: number): Span {
  let lo = 0;
  let hi = duration;
  const me = regions.find((r) => r.id === id);
  if (!me) return { start: lo, end: hi };
  for (const r of regions) {
    if (r.id === id) continue;
    if (r.end <= me.start + 1e-9) lo = Math.max(lo, r.end);
    else if (r.start >= me.end - 1e-9) hi = Math.min(hi, r.start);
  }
  return { start: lo, end: hi };
}

export function nextColor(regions: readonly LoopRegion[]): string {
  const used = new Set(regions.map((r) => r.color));
  return REGION_COLORS.find((c) => !used.has(c)) ?? REGION_COLORS[regions.length % REGION_COLORS.length]!;
}

let counter = 0;
export function newRegionId(): string {
  counter += 1;
  return `loop-${counter}`;
}

let cutCounter = 0;
export function newCutId(): string {
  cutCounter += 1;
  return `cut-${cutCounter}`;
}

/** Cuts in song order. */
export function sortCuts(cuts: readonly Cut[]): Cut[] {
  return sortRegions(cuts);
}

/** Is `span` overlapping any region? */
export function overlapsAny(regions: readonly Occupied[], span: Span, excludeId?: string): boolean {
  return regions.some((r) => r.id !== excludeId && r.start < span.end - 1e-9 && r.end > span.start + 1e-9);
}

// ---------------------------------------------------------------------------
// The whole-song loop (SPEC-v1.4.md 3)
// ---------------------------------------------------------------------------

/** Is this loop a whole-song loop: made by "Loop the whole song" and still covering most of the song? */
export function isWholeSong(region: Pick<LoopRegion, 'start' | 'end' | 'wholeSong'>, duration: number): boolean {
  return region.wholeSong === true && duration > 0 && (region.end - region.start) / duration >= ANALYSIS_CONFIG.wholeSong.minCoverage - 1e-6;
}

/** What a whole-song loop over `span` would collide with. Loops it would replace, and cuts that block it. */
export interface WholeSongConflicts {
  /** Loops inside or overlapping the span, in song order, with their 1-based numbers as the Your loops card shows them. */
  loops: { number: number; region: LoopRegion }[];
  /** Cuts inside or overlapping the span, in song order. A cut inside the span is refused, never removed. */
  cuts: Cut[];
}

export function wholeSongConflicts(span: Span, regions: readonly LoopRegion[], cuts: readonly Cut[]): WholeSongConflicts {
  const hits = (r: Span): boolean => r.start < span.end - 1e-6 && r.end > span.start + 1e-6;
  return {
    loops: sortRegions(regions)
      .map((region, i) => ({ number: i + 1, region }))
      .filter((l) => hits(l.region)),
    cuts: sortCuts(cuts).filter(hits),
  };
}

// ---------------------------------------------------------------------------
// Seam smoothing state of a loop
// ---------------------------------------------------------------------------

/** Smoothing is on unless the user turned it off (or pressed Undo). */
export function isSmooth(region: Pick<LoopRegion, 'smooth'>): boolean {
  return region.smooth !== false;
}

/** Does the plan belong to the loop's current points? */
export function planFits(region: Pick<LoopRegion, 'start' | 'end'>, plan: SeamPlan): boolean {
  return Math.abs(plan.forStart - region.start) < 1e-6 && Math.abs(plan.forEnd - region.end) < 1e-6;
}

/** Attach a seam plan to a loop, if it was computed for the loop's current points; otherwise the loop is returned unchanged. */
export function withSeamPlan(region: LoopRegion, plan: SeamPlan | null): LoopRegion {
  if (!plan || !planFits(region, plan)) return region;
  return { ...region, seam: plan };
}

/**
 * Undo (SPEC-seams.md 3.5): turn smoothing off for the loop and forget what the smoother decided. The loop's own
 * points were never moved (the plan only says how to play them), so it plays exactly as the user set it.
 */
export function undoSmoothing(region: LoopRegion): LoopRegion {
  const { seam: _plan, ...rest } = region;
  return { ...rest, smooth: false };
}

// ---------------------------------------------------------------------------
// Exact points of a loop or a cut: what is refused, and why
// ---------------------------------------------------------------------------

/** What `checkSpanPoints` needs to know about the edit. */
export interface SpanEdit {
  /**
   * The thing being edited: a loop, a cut or the waveform selection (SPEC-v1.3.md 7.2). A selection follows the same rules
   * as a cut, except that it may overlap anything: refusing that is up to Add as loop and Cut, which say why.
   */
  what: 'loop' | 'cut' | 'selection';
  /** Its id (it is not its own neighbour). */
  id: string;
  start: number;
  end: number;
  /** Which edge changed: the message names it. */
  edge: 'start' | 'end';
  duration: number;
  regions: readonly LoopRegion[];
  cuts: readonly Cut[];
}

/**
 * Why a loop or cut with these points is not allowed, or null. Exact times are never clamped: a bad one is refused.
 * Loops and cuts share the rules (inside the song, end after start, no overlap with a loop or a cut) and differ in the
 * shortest length (0.1 s for a loop, 50 ms for a cut). A cut may start at 0 or run to the end of the song.
 */
export function checkSpanPoints(e: SpanEdit): string | null {
  const noun = e.what;
  const value = e.edge === 'start' ? e.start : e.end;
  if (!Number.isFinite(value)) return 'That is not a time.';
  if (value < 0) return `A ${noun} cannot go before the start of the song (${formatClock(0)}).`;
  if (value > e.duration + 1e-9) return `Past the end of the song (${formatClock(e.duration)}).`;
  if (e.end <= e.start + 1e-9) {
    return e.edge === 'start' ? `Start must be before end (${formatClock(e.end)}).` : `End must be after start (${formatClock(e.start)}).`;
  }
  const min = e.what === 'loop' ? MIN_REGION_SECONDS : MIN_CUT_SECONDS;
  if (e.end - e.start < min - 1e-9) return `A ${noun} must be at least ${min} s long.`;
  if (e.what === 'selection') return null;
  const hits = (r: Span): boolean => r.start < e.end - 1e-9 && r.end > e.start + 1e-9;
  const loops = sortRegions(e.regions);
  const loop = loops.find((r) => !(e.what === 'loop' && r.id === e.id) && hits(r));
  if (loop) return `Overlaps Loop ${loops.indexOf(loop) + 1} (${formatClock(loop.start)}\u2013${formatClock(loop.end)}).`;
  const cuts = sortCuts(e.cuts);
  const cut = cuts.find((c) => !(e.what === 'cut' && c.id === e.id) && hits(c));
  if (cut) return `Overlaps Cut ${cuts.indexOf(cut) + 1} (${formatClock(cut.start)}\u2013${formatClock(cut.end)}).`;
  return null;
}

// ---------------------------------------------------------------------------
// The ending (SPEC-v1.3.md 3): where the extended song stops, and the fade into it
// ---------------------------------------------------------------------------

/** No end point (the real ending) and no fade. */
export const REAL_ENDING: Ending = { endAt: null, fadeSeconds: 0 };

/** Does the plan end anywhere but at the end of the song, or fade? */
export function hasEnding(e: Ending | undefined): boolean {
  return Boolean(e && (e.endAt !== null || e.fadeSeconds > 0));
}

/**
 * Why an End at time is not allowed, or null. `natural` is the length of the extended song before the end point trims it.
 * The end must be after 0 and within the extended song, and the fade into it cannot be longer than it.
 */
export function checkEndAt(endAt: number, fadeSeconds: number, natural: number): string | null {
  if (!Number.isFinite(endAt)) return 'That is not a time.';
  if (endAt <= 0) return `End at must be after ${formatClock(0)}.`;
  if (endAt > natural + 5e-4) return `The extended song is only ${formatClock(natural)} long. End at must be before that.`;
  if (fadeSeconds > endAt + 1e-9) {
    return `The fade (${fadeSeconds} s) is longer than the song up to End at (${formatClock(endAt)}). Make the fade shorter or End at later.`;
  }
  return null;
}

/**
 * Why a fade length is not allowed, or null: 0 to 60 s, and not longer than the song up to its end point (`endAt`, or the
 * whole extended song, `natural`, when it ends at its real ending).
 */
export function checkFade(fadeSeconds: number, endAt: number | null, natural: number): string | null {
  if (!Number.isFinite(fadeSeconds)) return 'That is not a number of seconds.';
  if (fadeSeconds < 0 || fadeSeconds > MAX_FADE_SECONDS) return `The fade is 0 to ${MAX_FADE_SECONDS} seconds.`;
  const limit = endAt ?? natural;
  if (fadeSeconds > limit + 1e-9) {
    return endAt === null
      ? `The fade can't be longer than the song (${formatClock(natural)}).`
      : `The fade can't be longer than End at (${formatClock(endAt)}).`;
  }
  return null;
}
