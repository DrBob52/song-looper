import { describe, expect, it } from 'vitest';
import type { LoopRegion } from '../../src/model';
import { REGION_COLORS } from '../../src/model';
import { fitSpan, freeGaps, neighbourBounds, nextColor, overlapsAny } from '../../src/plan';

const r = (id: string, start: number, end: number): LoopRegion => ({ id, start, end, repeats: 2, color: REGION_COLORS[0]! });

describe('plan helpers', () => {
  const regions = [r('b', 40, 50), r('a', 10, 20)];

  it('finds free gaps', () => {
    expect(freeGaps(regions, 60)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 40 },
      { start: 50, end: 60 },
    ]);
    expect(freeGaps([], 30)).toEqual([{ start: 0, end: 30 }]);
    expect(freeGaps(regions, 60, 'a')[0]).toEqual({ start: 0, end: 40 });
  });

  it('fits a span into a free gap or refuses', () => {
    expect(fitSpan(regions, { start: 22, end: 30 }, 60)).toEqual({ start: 22, end: 30 });
    expect(fitSpan(regions, { start: 15, end: 30 }, 60)).toEqual({ start: 20, end: 30 });
    expect(fitSpan(regions, { start: 30, end: 45 }, 60)).toEqual({ start: 30, end: 40 });
    expect(fitSpan(regions, { start: 12, end: 18 }, 60)).toBeNull();
    expect(fitSpan(regions, { start: 55, end: 70 }, 60)).toEqual({ start: 55, end: 60 });
    expect(fitSpan(regions, { start: 19.95, end: 20.02 }, 60)).toBeNull();
  });

  it('computes neighbour bounds', () => {
    expect(neighbourBounds(regions, 'a', 60)).toEqual({ start: 0, end: 40 });
    expect(neighbourBounds(regions, 'b', 60)).toEqual({ start: 20, end: 60 });
  });

  it('detects overlaps', () => {
    expect(overlapsAny(regions, { start: 19, end: 21 })).toBe(true);
    expect(overlapsAny(regions, { start: 20, end: 25 })).toBe(false);
    expect(overlapsAny(regions, { start: 19, end: 21 }, 'a')).toBe(false);
  });

  it('picks unused colours first', () => {
    expect(nextColor([])).toBe(REGION_COLORS[0]);
    expect(nextColor([{ ...r('a', 0, 1), color: REGION_COLORS[0]! }])).toBe(REGION_COLORS[1]);
  });
});
