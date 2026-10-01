import type { JumpPlan, LoopRegion, Span } from '../model';

/**
 * How a loop is played: the loop itself (where the last repeat plays through and leaves) and the cycle that
 * every other repeat plays, as source pieces joined by jumps.
 *
 *   pieces[0] = loop start .. first jump     (the loop, plus the first stretch of a bridge if there is one)
 *   pieces[k] = where jump k-1 landed .. jump k
 *   jumps[k]  leaves the end of pieces[k] and lands on the start of pieces[(k + 1) % n]; the last one lands on the loop start
 *
 * Without smoothing or a bridge this is the plain loop: one piece and one jump back from the end to the start.
 */
export interface LoopPath {
  /** The loop's own edges (seconds): where the final repeat plays through. */
  start: number;
  end: number;
  pieces: Span[];
  jumps: JumpPlan[];
}

const SAME = 1e-6;

/** The seam plan of a region, if it was computed for the region's current points. */
export function currentSeam(region: Pick<LoopRegion, 'start' | 'end' | 'seam'>): NonNullable<LoopRegion['seam']> | null {
  const plan = region.seam;
  if (!plan) return null;
  if (Math.abs(plan.forStart - region.start) > SAME || Math.abs(plan.forEnd - region.end) > SAME) return null;
  if (plan.jumps.length === 0) return null;
  return plan;
}

export function loopPath(region: Pick<LoopRegion, 'start' | 'end' | 'seam'>): LoopPath {
  const plan = currentSeam(region);
  if (!plan) {
    return {
      start: region.start,
      end: region.end,
      pieces: [{ start: region.start, end: region.end }],
      jumps: [{ from: region.end, to: region.start }],
    };
  }
  const pieces: Span[] = plan.jumps.map((j, k) => ({
    start: k === 0 ? plan.loopStart : plan.jumps[k - 1]!.to,
    end: j.from,
  }));
  return { start: plan.loopStart, end: plan.loopEnd, pieces, jumps: plan.jumps };
}

/** Seconds that one cycle (loop plus bridge) adds each time it repeats. */
export function cycleSeconds(path: LoopPath): number {
  return path.pieces.reduce((s, p) => s + (p.end - p.start), 0);
}

/** Seconds that the bridge adds to every repeat but the last (0 without one). */
export function bridgeSeconds(path: LoopPath): number {
  return cycleSeconds(path) - (path.end - path.start);
}
