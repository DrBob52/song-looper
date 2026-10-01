import { describe, expect, it } from 'vitest';
import { solveRepeats } from '../../src/audio/target';
import { checkEndAt, checkFade, hasEnding, REAL_ENDING } from '../../src/plan';

// SPEC-v1.3.md 3: the ending's validation and End exactly at target.

describe('End at and Fade out validation', () => {
  const natural = 372; // 6:12

  it('End at must be after 0 and within the extended song, with a specific message', () => {
    expect(checkEndAt(100, 0, natural)).toBeNull();
    expect(checkEndAt(natural, 0, natural)).toBeNull();
    expect(checkEndAt(0, 0, natural)).toBe('End at must be after 0:00.000.');
    expect(checkEndAt(-3, 0, natural)).toBe('End at must be after 0:00.000.');
    expect(checkEndAt(400, 0, natural)).toBe('The extended song is only 6:12.000 long. End at must be before that.');
    expect(checkEndAt(Number.NaN, 0, natural)).toBe('That is not a time.');
  });

  it("the fade can't be longer than End at", () => {
    expect(checkEndAt(5, 8, natural)).toBe('The fade (8 s) is longer than the song up to End at (0:05.000). Make the fade shorter or End at later.');
    expect(checkEndAt(8, 8, natural)).toBeNull();
    expect(checkFade(8, 5, natural)).toBe("The fade can't be longer than End at (0:05.000).");
    expect(checkFade(8, null, 6)).toBe("The fade can't be longer than the song (0:06.000).");
    expect(checkFade(8, null, natural)).toBeNull();
  });

  it('a fade is 0 to 60 seconds; 0 is no fade', () => {
    expect(checkFade(0, null, natural)).toBeNull();
    expect(checkFade(60, null, natural)).toBeNull();
    expect(checkFade(60.1, null, natural)).toBe('The fade is 0 to 60 seconds.');
    expect(checkFade(-1, null, natural)).toBe('The fade is 0 to 60 seconds.');
  });

  it('knows whether a plan has an ending at all', () => {
    expect(hasEnding(undefined)).toBe(false);
    expect(hasEnding(REAL_ENDING)).toBe(false);
    expect(hasEnding({ endAt: 10, fadeSeconds: 0 })).toBe(true);
    expect(hasEnding({ endAt: null, fadeSeconds: 2 })).toBe(true);
  });
});

describe('solveRepeats with a minimum (End exactly at target)', () => {
  const regions = [{ start: 20, end: 36, score: 0.9 }, { start: 60, end: 92, score: 0.6 }, { start: 120, end: 128, score: 0.7 }];

  it('is never shorter than the target, and over it by less than the shortest cycle', () => {
    for (let t = 205; t <= 900; t += 7.3) {
      const r = solveRepeats(regions, 200, t, Infinity, t);
      expect(r.total).toBeGreaterThanOrEqual(t - 1e-9);
      expect(r.total - t).toBeLessThan(8 + 1e-9);
    }
  });

  it('takes the closest total from above even when one from below is closer', () => {
    const one = [{ start: 0, end: 10 }];
    // 200 + 10 k: the closest to 234 is 230 (k = 3), at least 234 is 240
    expect(solveRepeats(one, 200, 234).total).toBe(230);
    expect(solveRepeats(one, 200, 234, Infinity, 234).total).toBe(240);
    // a target that is hit exactly is kept
    expect(solveRepeats(one, 200, 240, Infinity, 240).total).toBe(240);
  });

  it('a target that is not longer than the song leaves everything at 1', () => {
    expect(solveRepeats(regions, 200, 150, Infinity, 150).repeats).toEqual([1, 1, 1]);
  });
});
