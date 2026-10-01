import type { LoopRegion, SeamPlan, Span } from './model';
import { REGION_COLORS } from './model';

export const MIN_REGION_SECONDS = 0.1;

export function sortRegions(regions: readonly LoopRegion[]): LoopRegion[] {
  return [...regions].sort((a, b) => a.start - b.start);
}

/** Free spans of the song not covered by any region (optionally ignoring one region). */
export function freeGaps(regions: readonly LoopRegion[], duration: number, excludeId?: string): Span[] {
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
  regions: readonly LoopRegion[],
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
export function neighbourBounds(regions: readonly LoopRegion[], id: string, duration: number): Span {
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

/** Is `span` overlapping any region? */
export function overlapsAny(regions: readonly LoopRegion[], span: Span, excludeId?: string): boolean {
  return regions.some((r) => r.id !== excludeId && r.start < span.end - 1e-9 && r.end > span.start + 1e-9);
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
