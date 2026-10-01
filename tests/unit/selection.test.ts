import { describe, expect, it } from 'vitest';
import type { Cut, LoopRegion } from '../../src/model';
import { checkSpanPoints } from '../../src/plan';
import { placeSelectionLabels } from '../../src/ui/selectionLabels';
import { describeLength } from '../../src/ui/selectionBar';

// SPEC-v1.3.md 7.2: typed selection times, and the timestamps at the selection's edges.

describe('checkSpanPoints for the selection: the loop fields\' parsing rules and messages, but nothing to overlap', () => {
  const loops: LoopRegion[] = [{ id: 'l1', start: 10, end: 20, repeats: 2, color: '#000' }];
  const cuts: Cut[] = [{ id: 'c1', start: 30, end: 35 }];
  const check = (start: number, end: number, edge: 'start' | 'end' = 'end') =>
    checkSpanPoints({ what: 'selection', id: 'selection', start, end, edge, duration: 60, regions: loops, cuts });

  it('accepts a span anywhere in the song, over a loop or a cut too (Add as loop and Cut say why they refuse)', () => {
    expect(check(5, 25)).toBeNull();
    expect(check(28, 40)).toBeNull();
    expect(check(0, 60)).toBeNull();
    expect(check(12, 12.05)).toBeNull();
  });

  it('refuses what the loop fields refuse, in the same words', () => {
    expect(check(-1, 5, 'start')).toBe('A selection cannot go before the start of the song (0:00.000).');
    expect(check(5, 61)).toBe('Past the end of the song (1:00.000).');
    expect(check(8, 8, 'end')).toBe('End must be after start (0:08.000).');
    expect(check(9, 8, 'start')).toBe('Start must be before end (0:08.000).');
    expect(check(8, 8.01)).toBe('A selection must be at least 0.05 s long.');
    expect(check(Number.NaN, 8, 'start')).toBe('That is not a time.');
    // the same wording for a loop
    expect(checkSpanPoints({ what: 'loop', id: 'x', start: -1, end: 5, edge: 'start', duration: 60, regions: [], cuts: [] })).toBe(
      'A loop cannot go before the start of the song (0:00.000).',
    );
  });
});

describe('the selection bar\'s length', () => {
  it('is seconds to the millisecond, and bars when there is a beat grid', () => {
    expect(describeLength({ start: 69.6, end: 72 }, 1.2)).toBe('2.400 s · 1.2 bars');
    expect(describeLength({ start: 0, end: 8 }, 4)).toBe('8.000 s · 4 bars');
    expect(describeLength({ start: 1, end: 1.5 }, 0.25)).toBe('0.500 s · 0.3 bars');
    expect(describeLength({ start: 1, end: 3.25 }, null)).toBe('2.250 s');
  });
});

describe('placeSelectionLabels: timestamps at the two edges, flipped inside near the edges, one combined label when narrow', () => {
  const w = { start: 60, end: 60, both: 130 };
  const W = 1000;

  it('puts each label just outside its edge: the start label to the left, the end label to the right', () => {
    const r = placeSelectionLabels(300, 600, W, w);
    expect(r).toEqual({ kind: 'edges', start: 300 - 3 - 60, end: 603 });
  });

  it('flips the start label inside when it would run off the left edge, the end label when it would run off the right', () => {
    expect(placeSelectionLabels(20, 400, W, w)).toEqual({ kind: 'edges', start: 23, end: 403 });
    expect(placeSelectionLabels(300, 990, W, w)).toEqual({ kind: 'edges', start: 237, end: 990 - 3 - 60 });
    // both at once: a selection of the whole song
    expect(placeSelectionLabels(0, W, W, w)).toEqual({ kind: 'edges', start: 3, end: W - 3 - 60 });
  });

  it('shows one combined label, centred, when the selection is narrower than it', () => {
    expect(placeSelectionLabels(500, 520, W, w)).toEqual({ kind: 'both', left: 510 - 65 });
    expect(placeSelectionLabels(500, 500 + 129, W, w).kind).toBe('both');
    expect(placeSelectionLabels(500, 500 + 130, W, w).kind).toBe('edges');
  });

  it('keeps the combined label on the waveform, at either end', () => {
    expect(placeSelectionLabels(0, 10, W, w)).toEqual({ kind: 'both', left: 0 });
    expect(placeSelectionLabels(W - 10, W, W, w)).toEqual({ kind: 'both', left: W - 130 });
  });

  it('never lets two labels touch or leave the waveform, over a sweep of selections and widths', () => {
    for (const width of [290, 340, 700, 1000, 1432]) {
      for (let x0 = 0; x0 < width; x0 += 7) {
        for (let len = 1; x0 + len <= width; len += 11) {
          const r = placeSelectionLabels(x0, x0 + len, width, w);
          if (r.kind === 'both') {
            expect(r.left).toBeGreaterThanOrEqual(0);
            expect(r.left + w.both).toBeLessThanOrEqual(width);
          } else {
            for (const [at, size] of [[r.start, w.start], [r.end, w.end]] as const) {
              expect(at).toBeGreaterThanOrEqual(0);
              expect(at + size).toBeLessThanOrEqual(width);
            }
            const [a, b] = r.start <= r.end ? [[r.start, w.start], [r.end, w.end]] : [[r.end, w.end], [r.start, w.start]];
            expect(a![0]! + a![1]!).toBeLessThanOrEqual(b![0]! - 6 + 1e-9);
          }
        }
      }
    }
  });
});
