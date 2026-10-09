import { describe, expect, it } from 'vitest';
import type { Cut, LoopRegion } from '../../src/model';
import { isWholeSong, wholeSongConflicts } from '../../src/plan';
import { cutBlockText, replaceText, wholeSongNote } from '../../src/ui/wholeSongPanel';
import type { Analysis } from '../../src/analysis/types';

const loop = (id: string, start: number, end: number): LoopRegion => ({ id, start, end, repeats: 2, color: '#000' });
const cut = (id: string, start: number, end: number): Cut => ({ id, start, end });

describe('whole-song conflicts', () => {
  const span = { start: 12, end: 200 };

  it('finds the loops inside (numbered as the card shows them, in song order) and the cuts', () => {
    const c = wholeSongConflicts(span, [loop('b', 100, 110), loop('a', 20, 30), loop('z', 0, 8)], [cut('x', 100.5, 101), cut('y', 205, 210)]);
    expect(c.loops.map((l) => [l.number, l.region.id])).toEqual([[2, 'a'], [3, 'b']]);
    expect(c.cuts.map((x) => x.id)).toEqual(['x']);
  });

  it('counts a loop or cut that only partly overlaps, and not one that just touches', () => {
    const c = wholeSongConflicts(span, [loop('a', 5, 14), loop('b', 190, 210), loop('c', 0, 12), loop('d', 200, 220)], [cut('x', 0, 12), cut('y', 199, 230)]);
    expect(c.loops.map((l) => l.region.id)).toEqual(['a', 'b']);
    expect(c.cuts.map((x) => x.id)).toEqual(['y']);
  });

  it('has nothing to say about loops and cuts outside the span', () => {
    const c = wholeSongConflicts(span, [loop('a', 0, 8)], [cut('x', 220, 230)]);
    expect(c).toEqual({ loops: [], cuts: [] });
  });
});

describe('texts', () => {
  it('names the loops it replaces and the cuts it needs removed', () => {
    const l = (n: number) => ({ number: n, region: loop('x', 0, 1) });
    expect(replaceText([l(1)])).toBe('This replaces Loop 1');
    expect(replaceText([l(1), l(2)])).toBe('This replaces Loop 1 and Loop 2');
    expect(replaceText([l(1), l(2), l(4)])).toBe('This replaces Loop 1, Loop 2 and Loop 4');
    expect(cutBlockText([cut('x', 100, 101)])).toBe('Remove the cut at 1:40.000 first');
    expect(cutBlockText([cut('x', 100, 101), cut('y', 130.5, 131)])).toBe('Remove the cuts at 1:40.000 and 2:10.500 first');
  });

  it('says why there are no options', () => {
    const base = { wholeSong: [], skipped: undefined, steadyBeat: true } as unknown as Analysis;
    const note = (a: Partial<Analysis> | null, running = false, failed = false) => wholeSongNote({ analysis: a ? ({ ...base, ...a } as Analysis) : null, running, failed });
    expect(note({ skipped: 'short' })).toBe('The song is too short to loop as a whole');
    expect(note({ skipped: 'no-beats' })).toMatch(/^No steady beat found\. Drag a selection from just after the intro to just before the outro and press L\.$/);
    expect(note({ steadyBeat: false })).toMatch(/^No steady beat found\./);
    expect(note({ steadyBeat: true })).toMatch(/^No way of looping this whole song/);
    expect(note({ wholeSong: [{}] as Analysis['wholeSong'] })).toBeNull();
    expect(note(null, true)).toBe('Analysing the song…');
    expect(note(null)).toBe('Load a song first.');
  });
});

describe('isWholeSong', () => {
  it('needs the flag and at least 60% of the song', () => {
    expect(isWholeSong({ start: 10, end: 90, wholeSong: true }, 100)).toBe(true);
    expect(isWholeSong({ start: 10, end: 90 }, 100)).toBe(false);
    expect(isWholeSong({ start: 10, end: 60, wholeSong: true }, 100)).toBe(false);
    expect(isWholeSong({ start: 0, end: 60, wholeSong: true }, 100)).toBe(true);
  });
});
