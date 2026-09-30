import { describe, expect, it } from 'vitest';
import { solveRepeats } from '../../src/audio/target';

const D = 200;
const mk = (spans: [number, number, number?][]): { start: number; end: number; score?: number }[] =>
  spans.map(([start, end, score]) => ({ start, end, score }));

describe('solveRepeats', () => {
  it('is within half of the shortest region length of the target, for many targets', () => {
    const regions = mk([
      [20, 36, 0.9],
      [60, 92, 0.6],
      [120, 128, 0.7],
    ]);
    const shortest = 8;
    for (let t = 205; t <= 900; t += 7.3) {
      const r = solveRepeats(regions, D, t);
      expect(Math.abs(r.error)).toBeLessThanOrEqual(shortest / 2 + 1e-9);
      expect(r.repeats.every((x) => x >= 1 && x <= 64 && Number.isInteger(x))).toBe(true);
      expect(r.total).toBeCloseTo(t + r.error, 9);
    }
  });

  it('works for user regions without scores (equal split) and for a single region', () => {
    const one = mk([[10, 20]]);
    for (const t of [205, 230, 255, 301.5, 480]) {
      const r = solveRepeats(one, D, t);
      expect(Math.abs(r.error)).toBeLessThanOrEqual(5 + 1e-9);
      expect(r.total).toBeCloseTo(D + (r.repeats[0]! - 1) * 10, 9);
    }
    const two = mk([
      [0, 10],
      [50, 62],
    ]);
    for (let t = 210; t < 600; t += 13) {
      expect(Math.abs(solveRepeats(two, D, t).error)).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it('splits extra time in proportion to the scores', () => {
    // equal lengths, scores 3:1 -> about three times as many extra repeats
    const r = solveRepeats(
      mk([
        [0, 10, 0.9],
        [50, 60, 0.3],
      ]),
      200,
      280,
    );
    expect(r.repeats[0]! - 1).toBeGreaterThan(r.repeats[1]! - 1);
    expect(r.total).toBe(280);
  });

  it('leaves everything at 1 when the target is not longer than the original', () => {
    const regions = mk([[0, 10], [20, 30]]);
    for (const t of [0, 100, 200]) {
      const r = solveRepeats(regions, D, t);
      expect(r.repeats).toEqual([1, 1]);
      expect(r.total).toBe(D);
    }
  });

  it('caps at 64 repeats per region and handles no regions', () => {
    const r = solveRepeats(mk([[0, 10]]), D, 100000);
    expect(r.repeats).toEqual([64]);
    expect(r.total).toBe(D + 63 * 10);
    expect(solveRepeats([], D, 500)).toEqual({ repeats: [], total: D, error: D - 500 });
  });

  it('does not overshoot by more than half of the shortest region when it can also remove repeats', () => {
    const r = solveRepeats(mk([[0, 9, 0.5], [30, 47, 0.5], [90, 103, 0.5]]), 150, 399);
    expect(Math.abs(r.error)).toBeLessThanOrEqual(4.5 + 1e-9);
  });
});
