import { describe, expect, it } from 'vitest';
import type { Cut, LoopRegion } from '../../src/model';
import {
  buildTimeline,
  cutStretch,
  extendedDuration,
  extendedToOriginal,
  fadeInGain,
  fadeOutGain,
  mergeCuts,
  naturalDuration,
  originalToExtended,
  planKey,
  plannedFrames,
  renderExtended,
  renderRange,
} from '../../src/audio/render';
import { renderCutSnippet } from '../../src/audio/preview';
import { makeBuffer } from '../../src/audio/types';
import { MIN_CUT_SECONDS, checkSpanPoints, fitSpan, neighbourBounds } from '../../src/plan';
import { sine } from '../fixtures/synth';

// SPEC-v1.3.md 2: cuts are spans of the original song that the extended song skips.

const loop = (id: string, start: number, end: number, repeats: number): LoopRegion => ({ id, start, end, repeats, color: '#000' });
const cut = (id: string, start: number, end: number): Cut => ({ id, start, end });
const exact = { snapZeroCrossings: false } as const;

describe('cuts in the timeline and its lengths', () => {
  it('a cut in the middle is skipped: the song is shorter by its length, and the join is marked', () => {
    const plan = { regions: [], cuts: [cut('c', 3, 5)] };
    const t = buildTimeline(plan, 10);
    expect(t.map((s) => [s.kind, s.start, s.end, s.outStart, s.outEnd])).toEqual([
      ['original', 0, 3, 0, 3],
      ['original', 5, 10, 3, 8],
    ]);
    expect(t[0]!.skipBefore).toBeUndefined();
    expect(t[1]!.skipBefore).toEqual({ start: 3, end: 5 });
    expect(naturalDuration(plan, 10)).toBe(8);
    expect(extendedDuration(plan, 10)).toBe(8);
  });

  it('a cut at the start removes the intro and one at the end removes the outro', () => {
    const start = buildTimeline({ regions: [], cuts: [cut('c', 0, 2)] }, 10);
    expect(start.map((s) => [s.start, s.end, s.outStart, s.outEnd])).toEqual([[2, 10, 0, 8]]);
    expect(start[0]!.skipBefore).toEqual({ start: 0, end: 2 });
    const end = buildTimeline({ regions: [], cuts: [cut('c', 7, 10)] }, 10);
    expect(end.map((s) => [s.start, s.end, s.outStart, s.outEnd])).toEqual([[0, 7, 0, 7]]);
    expect(end[0]!.skipAfter).toEqual({ start: 7, end: 10 });
    expect(extendedDuration({ regions: [], cuts: [cut('a', 0, 2), cut('b', 7, 10)] }, 10)).toBe(5);
  });

  it('cuts and loops together: the length is D - cuts + (repeats - 1) * loop', () => {
    const plan = { regions: [loop('a', 10, 14, 3), loop('b', 30, 32, 2)], cuts: [cut('1', 0, 4), cut('2', 14, 20), cut('3', 40, 50)] };
    const duration = 50;
    expect(naturalDuration(plan, duration)).toBeCloseTo(50 - 4 - 6 - 10 + 2 * 4 + 1 * 2, 9);
    const t = buildTimeline(plan, duration);
    expect(t[t.length - 1]!.outEnd).toBeCloseTo(naturalDuration(plan, duration), 9);
    // the loop right after a cut: its first play is the one that follows the skip
    const firstB = t.find((s) => s.regionId === 'b' && s.repeat === 1)!;
    expect(firstB.skipBefore).toBeUndefined(); // a plain stretch (20 to 30) comes between
    const afterCut = t.find((s) => s.skipBefore?.start === 14)!;
    expect(afterCut).toMatchObject({ kind: 'original', start: 20 });
    // a cut ending exactly where a loop starts: the loop's first play carries the mark
    const t2 = buildTimeline({ regions: [loop('a', 10, 14, 2)], cuts: [cut('c', 6, 10)] }, 20);
    expect(t2.find((s) => s.kind === 'repeat' && s.repeat === 1)!.skipBefore).toEqual({ start: 6, end: 10 });
  });

  it('cuts never play inside a loop: the part of a cut that overlaps one is dropped', () => {
    const plan = { regions: [loop('a', 10, 15, 2)], cuts: [cut('c', 8, 12), cut('d', 14, 18)] };
    expect(mergeCuts(plan.cuts, 30, [{ start: 10, end: 15 }])).toEqual([
      { start: 8, end: 10 },
      { start: 15, end: 18 },
    ]);
    expect(naturalDuration(plan, 30)).toBeCloseTo(30 - 2 - 3 + 5, 9);
  });

  it('merges cuts that touch or overlap, and clips them to the song', () => {
    // (the last one lies wholly past the end of the song and goes)
    expect(mergeCuts([cut('b', 4, 6), cut('a', 1, 4), cut('c', 5.5, 7), cut('d', 12, 20), cut('e', 9, 15)], 10)).toEqual([
      { start: 1, end: 7 },
      { start: 9, end: 10 },
    ]);
  });

  it('cutStretch lists the pieces that play, the cut before each, and a cut that runs up to the end of the stretch', () => {
    expect(cutStretch(0, 10, [{ start: 2, end: 3 }, { start: 6, end: 10 }])).toEqual({
      pieces: [
        { start: 0, end: 2 },
        { start: 3, end: 6, skip: { start: 2, end: 3 } },
      ],
      trailing: { start: 6, end: 10 },
    });
    expect(cutStretch(0, 10, [{ start: 0, end: 4 }]).pieces).toEqual([{ start: 4, end: 10, skip: { start: 0, end: 4 } }]);
    expect(cutStretch(5, 5, [])).toEqual({ pieces: [] });
  });

  it('maps times between the original and the extended song across a cut', () => {
    const plan = { regions: [loop('a', 12, 14, 3)], cuts: [cut('c', 3, 5)] };
    const t = buildTimeline(plan, 20);
    // before the cut, after it (shifted back by its length), in the loop's first play
    expect(originalToExtended(t, 2)).toBeCloseTo(2, 9);
    expect(originalToExtended(t, 6)).toBeCloseTo(4, 9);
    expect(originalToExtended(t, 13)).toBeCloseTo(11, 9);
    // inside the cut: the join
    expect(originalToExtended(t, 4)).toBeCloseTo(3, 9);
    expect(extendedToOriginal(t, 2.5).time).toBeCloseTo(2.5, 9);
    expect(extendedToOriginal(t, 3.5).time).toBeCloseTo(5.5, 9);
    // a cut at the start: the song starts at its end
    const lead = buildTimeline({ regions: [], cuts: [cut('c', 0, 4)] }, 20);
    expect(originalToExtended(lead, 1)).toBe(0);
    expect(extendedToOriginal(lead, 0).time).toBe(4);
    // a cut at the end: the end of the song is where the outro was cut
    const trail = buildTimeline({ regions: [], cuts: [cut('c', 15, 20)] }, 20);
    expect(originalToExtended(trail, 18)).toBe(15);
  });

  it('the plan key changes with the cuts, and a plan without cuts keeps the key it had', () => {
    const base = { regions: [loop('a', 2, 4, 3)] };
    const withCut = { ...base, cuts: [cut('c', 6, 7)] };
    expect(planKey(withCut, 10, 20)).not.toBe(planKey(base, 10, 20));
    expect(planKey({ ...base, cuts: [] }, 10, 20)).toBe(planKey(base, 10, 20));
    expect(planKey({ ...withCut, cuts: [cut('c', 6, 7.5)] }, 10, 20)).not.toBe(planKey(withCut, 10, 20));
  });
});

describe('rendering with cuts', () => {
  const sr = 8000;

  it('the rendered length is the song minus its cuts (exact without snapping, within a few ms with it)', () => {
    const song = makeBuffer([new Float32Array(sr * 10)], sr);
    const plan = { regions: [loop('a', 5, 7, 3)], cuts: [cut('1', 0, 1), cut('2', 2, 3.5), cut('3', 9, 10)] };
    const expected = (10 - 1 - 1.5 - 1 + 2 * 2) * sr;
    expect(plannedFrames(song, plan, exact)).toBe(expected);
    expect(renderExtended(song, plan, exact)[0]!.length).toBe(expected);
    expect(renderRange(song, plan, 0, 1e9, exact)[0]!.length).toBe(expected);
    expect(Math.abs(plannedFrames(song, plan) - expected)).toBeLessThanOrEqual(0.006 * sr);
    expect(plannedFrames(song, plan)).toBe(renderExtended(song, plan)[0]!.length);
  });

  it('the plain song without a loop or a cut is the song itself, and a cut as long as the song leaves nothing', () => {
    const song = makeBuffer([sine(220, 2, sr, 0.5)], sr);
    expect(plannedFrames(song, { regions: [] })).toBe(song.length);
    expect(plannedFrames(song, { regions: [], cuts: [cut('c', 0, 2)] })).toBe(0);
  });

  it('a join is a crossfade: a cut of whole periods is seamless, and any other cut has no jump a hard splice would have', () => {
    const rate = 44100;
    const freq = 441; // 100 samples a period
    const song = makeBuffer([sine(freq, 6, rate, 0.5)], rate);
    const naturalStep = 0.5 * 2 * Math.PI * (freq / rate);
    const maxStep = (x: Float32Array): number => {
      let m = 0;
      for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
      return m;
    };
    // 1 s = 441 periods: both sides of the join are the same wave
    const whole = renderExtended(song, { regions: [], cuts: [cut('c', 2, 3)] })[0]!;
    expect(whole.length).toBe(5 * rate);
    expect(maxStep(whole)).toBeLessThan(naturalStep * 1.01);
    // 1.2345 s is not a whole number of periods: the two sides meet a quarter-period or so out of phase
    const odd = { regions: [], cuts: [cut('c', 2, 3.2345)] };
    const hard = maxStep(renderExtended(song, odd, { crossfadeMs: 0, snapZeroCrossings: false })[0]!);
    const soft = maxStep(renderExtended(song, odd, { snapZeroCrossings: false })[0]!);
    expect(hard).toBeGreaterThan(naturalStep * 3);
    expect(soft).toBeLessThan(naturalStep * 1.5);
    // and with the zero-crossing snap too
    expect(maxStep(renderExtended(song, odd)[0]!)).toBeLessThan(naturalStep * 1.5);
  });

  it('the join uses the Seam fade length setting', () => {
    const song = makeBuffer([new Float32Array(sr * 6).map((_, i) => Math.sin(i * 0.05) * 0.5 + (i < sr * 3 ? 0.2 : -0.2))], sr);
    const plan = { regions: [], cuts: [cut('c', 2, 3.5)] };
    const touched = (ms: number): number => {
      const out = renderExtended(song, plan, { crossfadeMs: ms, ...exact })[0]!;
      const join = 2 * sr;
      let first = -1;
      let last = -1;
      for (let i = join - 600; i < join + 600; i++) {
        // where the output differs from plain playback of the part before the cut or after it
        const before = song.getChannelData(0)[i]!;
        const after = song.getChannelData(0)[i + 1.5 * sr]!;
        if (i < join ? out[i] !== before : out[i] !== after) {
          if (first < 0) first = i;
          last = i;
        }
      }
      return last - first + 1;
    };
    expect(touched(40)).toBeGreaterThan(touched(10) * 3);
  });

  it('a cut at the start fades in over 10 ms from exactly 0, and one at the end fades out to exactly 0', () => {
    const song = makeBuffer([new Float32Array(sr * 4).fill(0.5)], sr);
    const fade = Math.round(0.01 * sr);
    const lead = renderExtended(song, { regions: [], cuts: [cut('c', 0, 1)] }, exact)[0]!;
    expect(lead.length).toBe(3 * sr);
    expect(lead[0]).toBe(0);
    expect(lead[fade - 1]).toBeCloseTo(0.5, 6);
    expect(lead[fade]).toBe(0.5);
    expect(lead[lead.length - 1]).toBe(0.5); // no fade at the other end
    for (let i = 1; i < fade; i++) expect(lead[i]!).toBeGreaterThanOrEqual(lead[i - 1]!);
    const tail = renderExtended(song, { regions: [], cuts: [cut('c', 3, 4)] }, exact)[0]!;
    expect(tail.length).toBe(3 * sr);
    expect(tail[tail.length - 1]).toBe(0);
    expect(tail[tail.length - fade - 1]).toBe(0.5);
    expect(tail[tail.length - fade]).toBeCloseTo(0.5, 6);
    expect(tail[0]).toBe(0.5);
  });
});

describe('the ending: length and fade at sample level (SPEC-v1.3.md 3.2)', () => {
  const sr = 8000;
  const dc = makeBuffer([new Float32Array(sr * 20).fill(0.5)], sr);

  it('the output length is the end point, trimmed from the natural length', () => {
    const plan = { regions: [loop('a', 4, 8, 4)], ending: { endAt: 21.5, fadeSeconds: 0 } };
    expect(naturalDuration(plan, 20)).toBe(32);
    expect(extendedDuration(plan, 20)).toBe(21.5);
    expect(plannedFrames(dc, plan, exact)).toBe(21.5 * sr);
    expect(renderExtended(dc, plan, exact)[0]!.length).toBe(21.5 * sr);
    // an end point past the end changes nothing, and the real ending stays the real ending
    expect(extendedDuration({ ...plan, ending: { endAt: 99, fadeSeconds: 0 } }, 20)).toBe(32);
    expect(extendedDuration({ ...plan, ending: { endAt: null, fadeSeconds: 5 } }, 20)).toBe(32);
    expect(plannedFrames(dc, { ...plan, ending: { endAt: 99, fadeSeconds: 0 } }, exact)).toBe(32 * sr);
  });

  it('the fade is a cosine: 1 before it, 1 at its first sample, about 0.707 in the middle, exactly 0 at the end', () => {
    const endAt = 12;
    const fadeSeconds = 2;
    const plan = { regions: [], ending: { endAt, fadeSeconds } };
    const out = renderExtended(dc, plan, exact)[0]!;
    const total = endAt * sr;
    const frames = fadeSeconds * sr;
    expect(out.length).toBe(total);
    const start = total - frames;
    expect(out[start - 1]).toBe(0.5);
    expect(out[start]).toBe(0.5);
    expect(out[total - 1]).toBe(0);
    const mid = start + (frames - 1) / 2; // frames is even: between two samples
    const around = (out[Math.floor(mid)]! + out[Math.ceil(mid)]!) / 2 / 0.5;
    expect(around).toBeGreaterThan(0.7);
    expect(around).toBeLessThan(0.714);
    for (let i = 0; i < frames; i++) expect(out[start + i]!).toBeCloseTo(0.5 * fadeOutGain(i, frames), 6);
    // monotonic, never louder than the song, and equal-power: gain^2 + (mirror gain)^2 is 1
    for (let i = 1; i < frames; i++) expect(out[start + i]!).toBeLessThanOrEqual(out[start + i - 1]!);
    expect(fadeOutGain(0, 1001)).toBe(1);
    expect(fadeOutGain(500, 1001)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(fadeOutGain(1000, 1001)).toBe(0);
    for (let i = 0; i < 1001; i += 37) expect(fadeOutGain(i, 1001) ** 2 + fadeInGain(i, 1001) ** 2).toBeCloseTo(1, 12);
  });

  it('a fade on the real ending covers the last seconds of the extended song, and a fade of 0 is no fade', () => {
    const plan = { regions: [loop('a', 4, 8, 3)], ending: { endAt: null, fadeSeconds: 3 } };
    const out = renderExtended(dc, plan, exact)[0]!;
    expect(out.length).toBe(28 * sr);
    expect(out[25 * sr - 1]).toBe(0.5);
    expect(out[out.length - 1]).toBe(0);
    const none = renderExtended(dc, { regions: [loop('a', 4, 8, 3)], ending: { endAt: 20, fadeSeconds: 0 } }, exact)[0]!;
    expect(none.length).toBe(20 * sr);
    expect(Math.min(...none.subarray(0, 100))).toBe(0.5);
    expect(none[none.length - 1]).toBe(0.5);
  });

  it('an explicit ending fade replaces the 10 ms fade of a cut to the end of the song', () => {
    const plan = { regions: [], cuts: [cut('c', 15, 20)], ending: { endAt: null, fadeSeconds: 2 } };
    const out = renderExtended(dc, plan, exact)[0]!;
    expect(out.length).toBe(15 * sr);
    expect(out[13 * sr - 1]).toBe(0.5);
    expect(out[out.length - 1]).toBe(0);
    // End at with no fade: a hard end (the user asked for exactly that)
    const hard = renderExtended(dc, { regions: [], cuts: [cut('c', 15, 20)], ending: { endAt: 10, fadeSeconds: 0 } }, exact)[0]!;
    expect(hard[hard.length - 1]).toBe(0.5);
  });

  it('renderRange gives the same samples across the fade as the full render', () => {
    const song = makeBuffer([sine(300, 20, sr, 0.5)], sr);
    const plan = { regions: [loop('a', 4, 8, 4)], cuts: [cut('c', 12, 14)], ending: { endAt: 25, fadeSeconds: 4 } };
    const full = renderExtended(song, plan)[0]!;
    for (const [from, len] of [[0, 1e9], [21 * sr - 5, 3000], [24 * sr, 5000], [25 * sr - 1, 10], [20 * sr, 5 * sr]] as const) {
      const piece = renderRange(song, plan, from, len)[0]!;
      expect(Array.from(piece)).toEqual(Array.from(full.subarray(from, from + len)));
    }
  });
});

describe('cuts: where they may go, and why not', () => {
  const regions = [loop('a', 10, 20, 2), loop('b', 40, 50, 2)];
  const cuts = [cut('x', 25, 30)];
  const edit = (start: number, end: number, edge: 'start' | 'end' = 'end', id = '') => checkSpanPoints({ what: 'cut', id, start, end, edge, duration: 60, regions, cuts });

  it('refuses an overlap with a loop or another cut and names it', () => {
    expect(edit(15, 22)).toBe('Overlaps Loop 1 (0:10.000–0:20.000).');
    expect(edit(45, 52)).toBe('Overlaps Loop 2 (0:40.000–0:50.000).');
    expect(edit(28, 33)).toBe('Overlaps Cut 1 (0:25.000–0:30.000).');
    expect(edit(21, 24)).toBeNull();
    // touching is fine
    expect(edit(20, 25)).toBeNull();
    expect(edit(30, 40)).toBeNull();
    // a cut is not its own neighbour
    expect(edit(26, 29, 'end', 'x')).toBeNull();
  });

  it('allows a cut from 0 and to the end of the song, and nothing outside it', () => {
    expect(edit(0, 5)).toBeNull();
    expect(edit(52, 60)).toBeNull();
    expect(edit(55, 61)).toBe('Past the end of the song (1:00.000).');
    expect(edit(-1, 3, 'start')).toBe('A cut cannot go before the start of the song (0:00.000).');
  });

  it('is at least 50 ms long, and the end is after the start', () => {
    expect(MIN_CUT_SECONDS).toBe(0.05);
    expect(edit(31, 31.049)).toBe('A cut must be at least 0.05 s long.');
    expect(edit(31, 31.05)).toBeNull();
    expect(edit(31, 30, 'end')).toBe('End must be after start (0:31.000).');
    expect(edit(35, 33, 'start')).toBe('Start must be before end (0:33.000).');
  });

  it('a loop may not overlap a cut either', () => {
    const msg = checkSpanPoints({ what: 'loop', id: 'a', start: 10, end: 27, edge: 'end', duration: 60, regions, cuts });
    expect(msg).toBe('Overlaps Cut 1 (0:25.000–0:30.000).');
  });

  it('loops and cuts block each other as obstacles, for dragging, adding and the seam smoother', () => {
    const all = [...regions, ...cuts];
    expect(neighbourBounds(all, 'a', 60)).toEqual({ start: 0, end: 25 });
    expect(neighbourBounds(all, 'x', 60)).toEqual({ start: 20, end: 40 });
    expect(fitSpan(all, { start: 18, end: 33 }, 60, MIN_CUT_SECONDS)).toEqual({ start: 20, end: 25 });
    expect(fitSpan(all, { start: 0, end: 5 }, 60, MIN_CUT_SECONDS)).toEqual({ start: 0, end: 5 });
  });
});

describe('cut audition', () => {
  const sr = 8000;
  const song = makeBuffer([sine(200, 30, sr, 0.5)], sr);

  it('plays 4 s before the join through 4 s after it, the same join as the extended song', () => {
    const snip = renderCutSnippet(song, { start: 10, end: 14 }, exact);
    expect(snip.channels[0]!.length).toBe(8 * sr);
    expect(snip.seamIndex).toBe(4 * sr);
    expect(snip.map).toEqual([
      { out: 0, src: 6 * sr },
      { out: 4 * sr, src: 14 * sr },
    ]);
    // equal to the same stretch of the full render around that join
    const full = renderExtended(song, { regions: [], cuts: [cut('c', 10, 14)] }, exact)[0]!;
    expect(Array.from(snip.channels[0]!)).toEqual(Array.from(full.subarray(6 * sr, 14 * sr)));
  });

  it('a cut at the start plays the song from its end, fading in; one at the end plays up to its start, fading out', () => {
    const lead = renderCutSnippet(song, { start: 0, end: 5 }, exact);
    expect(lead.channels[0]!.length).toBe(4 * sr);
    expect(lead.channels[0]![0]).toBe(0);
    expect(lead.map[0]).toEqual({ out: 0, src: 5 * sr });
    const tail = renderCutSnippet(song, { start: 26, end: 30 }, exact);
    expect(tail.channels[0]!.length).toBe(4 * sr);
    expect(Math.abs(tail.channels[0]![tail.channels[0]!.length - 1]!)).toBe(0);
  });
});
