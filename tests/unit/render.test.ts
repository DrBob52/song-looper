import { describe, expect, it } from 'vitest';
import type { LoopRegion, SeamPlan } from '../../src/model';
import { isSmooth, undoSmoothing, withSeamPlan } from '../../src/plan';
import {
  buildTimeline,
  extendedDuration,
  extendedToOriginal,
  normalizeRegions,
  originalToExtended,
  planKey,
  regionsToSamples,
  renderExtended,
  snapToZeroCrossing,
} from '../../src/audio/render';
import { renderLoopBody, renderSeamSnippet } from '../../src/audio/preview';
import { makeBuffer } from '../../src/audio/types';
import { sine } from '../fixtures/synth';

const region = (id: string, start: number, end: number, repeats: number): LoopRegion => ({
  id,
  start,
  end,
  repeats,
  color: '#000',
});

/** Deterministic pseudo-random noise in [-1, 1]. */
function noise(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = (x / 2147483648 - 1) * 0.8;
  }
  return out;
}

describe('buildTimeline', () => {
  it('covers the song when there are no regions', () => {
    const t = buildTimeline({ regions: [] }, 10);
    expect(t).toEqual([{ kind: 'original', start: 0, end: 10, outStart: 0, outEnd: 10 }]);
  });

  it('lays out original, repeats and original', () => {
    const t = buildTimeline({ regions: [region('a', 2, 4, 3)] }, 10);
    expect(t.map((s) => [s.kind, s.start, s.end, s.outStart, s.outEnd])).toEqual([
      ['original', 0, 2, 0, 2],
      ['repeat', 2, 4, 2, 4],
      ['repeat', 2, 4, 4, 6],
      ['repeat', 2, 4, 6, 8],
      ['original', 4, 10, 8, 14],
    ]);
    expect(t.filter((s) => s.kind === 'repeat').map((s) => s.repeat)).toEqual([1, 2, 3]);
  });

  it('handles regions touching the start and end and several regions', () => {
    const t = buildTimeline({ regions: [region('b', 6, 8, 2), region('a', 0, 1, 2)] }, 8);
    expect(t[0]).toMatchObject({ kind: 'repeat', regionId: 'a', start: 0, end: 1 });
    expect(t[t.length - 1]).toMatchObject({ kind: 'repeat', regionId: 'b', repeat: 2, outEnd: 11 });
    expect(extendedDuration({ regions: [region('b', 6, 8, 2), region('a', 0, 1, 2)] }, 8)).toBeCloseTo(11, 9);
  });

  it('output length = D + sum((repeats - 1) * regionLength)', () => {
    const plan = { regions: [region('a', 1, 3, 4), region('b', 5, 8.5, 2), region('c', 9, 9.5, 1)] };
    const expected = 12 + 3 * 2 + 1 * 3.5 + 0;
    expect(extendedDuration(plan, 12)).toBeCloseTo(expected, 9);
    const tl = buildTimeline(plan, 12);
    expect(tl[tl.length - 1]!.outEnd).toBeCloseTo(expected, 9);
  });

  it('trims overlaps, clips to the song and clamps repeats', () => {
    const r = normalizeRegions([region('a', 1, 5, 2), region('b', 4, 7, 20_000), region('c', 9, 20, 0)], 10);
    expect(r.map((x) => [x.id, x.start, x.end, x.repeats])).toEqual([
      ['a', 1, 5, 2],
      ['b', 5, 7, 9999],
      ['c', 9, 10, 1],
    ]);
  });

  it('maps between original and extended time', () => {
    const tl = buildTimeline({ regions: [region('a', 2, 4, 3)] }, 10);
    expect(originalToExtended(tl, 1)).toBe(1);
    expect(originalToExtended(tl, 3)).toBe(3);
    expect(originalToExtended(tl, 5)).toBe(9); // after the loop: shifted by 4 s
    expect(extendedToOriginal(tl, 5).time).toBe(3); // second repeat
    expect(extendedToOriginal(tl, 9).time).toBe(5);
    expect(extendedToOriginal(tl, 500).time).toBe(10);
  });
});

describe('extendedToOriginal on a long timeline', () => {
  it('finds the segment of any time (binary search) exactly as a scan would', () => {
    const plan = { regions: [region('a', 2, 4, 2500), region('b', 6, 7.5, 1500)] };
    const tl = buildTimeline(plan, 12);
    expect(tl.length).toBeGreaterThan(4000);
    const total = tl[tl.length - 1]!.outEnd;
    const scan = (t: number) => {
      for (const seg of tl) if (t < seg.outEnd) return { time: seg.start + Math.max(0, t - seg.outStart), segment: seg };
      const last = tl[tl.length - 1]!;
      return { time: last.end, segment: last };
    };
    let x = 12345;
    for (let i = 0; i < 400; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const t = (x / 0x7fffffff) * (total + 10) - 1;
      expect(extendedToOriginal(tl, t), String(t)).toEqual(scan(t));
    }
    for (const seg of tl.slice(0, 50)) {
      expect(extendedToOriginal(tl, seg.outStart)).toEqual(scan(seg.outStart));
      expect(extendedToOriginal(tl, seg.outEnd)).toEqual(scan(seg.outEnd));
    }
  });
});

describe('renderExtended', () => {
  const sr = 8000;

  it('repeats = 1 everywhere reproduces the input sample for sample', () => {
    const l = noise(sr * 5, 3);
    const r = noise(sr * 5, 4);
    const buf = makeBuffer([l, r], sr);
    const plan = { regions: [region('a', 1, 2, 1), region('b', 3, 4.5, 1)] };
    for (const crossfadeMs of [0, 20]) {
      for (const snapZeroCrossings of [false, true]) {
        const out = renderExtended(buf, plan, { crossfadeMs, snapZeroCrossings });
        expect(out.length).toBe(2);
        expect(out[0]!.length).toBe(l.length);
        expect(Array.from(out[0]!)).toEqual(Array.from(l));
        expect(Array.from(out[1]!)).toEqual(Array.from(r));
      }
    }
  });

  it('with no regions the output equals the input', () => {
    const l = noise(1000, 9);
    const out = renderExtended(makeBuffer([l], sr), { regions: [] });
    expect(Array.from(out[0]!)).toEqual(Array.from(l));
  });

  it('output length matches the timeline (crossfade off, no snapping)', () => {
    const l = noise(sr * 10, 5);
    const buf = makeBuffer([l], sr);
    const plan = { regions: [region('a', 1, 3, 4), region('b', 5, 8.5, 2)] };
    const out = renderExtended(buf, plan, { crossfadeMs: 0, snapZeroCrossings: false });
    expect(out[0]!.length).toBe(Math.round(extendedDuration(plan, 10) * sr));
  });

  it('copies the region verbatim when crossfade is off', () => {
    const l = noise(sr * 4, 6);
    const buf = makeBuffer([l], sr);
    const out = renderExtended(buf, { regions: [region('a', 1, 2, 3)] }, { crossfadeMs: 0, snapZeroCrossings: false });
    const s = sr;
    const e = 2 * sr;
    expect(Array.from(out[0]!.subarray(0, e))).toEqual(Array.from(l.subarray(0, e)));
    expect(Array.from(out[0]!.subarray(e, e + (e - s)))).toEqual(Array.from(l.subarray(s, e)));
    expect(Array.from(out[0]!.subarray(e + (e - s), e + 2 * (e - s)))).toEqual(Array.from(l.subarray(s, e)));
    expect(Array.from(out[0]!.subarray(e + 2 * (e - s)))).toEqual(Array.from(l.subarray(e)));
  });

  it('crossfade is equal-power and only touches the seam window', () => {
    const l = noise(sr * 4, 7);
    const buf = makeBuffer([l], sr);
    const crossfadeMs = 20;
    const out = renderExtended(
      buf,
      { regions: [region('a', 1, 2, 2)] },
      { crossfadeMs, snapZeroCrossings: false, adaptiveCrossfade: false },
    )[0]!;
    const half = Math.floor(0.02 * sr * 0.5); // 80 samples
    const e = 2 * sr;
    const s = sr;
    // Untouched before the window and after it (continuing from region start + half)
    expect(out[e - half - 1]).toBe(l[e - half - 1]);
    expect(out[e + half]).toBe(l[s + half]);
    // Gains at the window centre are equal: cos(pi/4) = sin(pi/4)
    const i = half; // centre of the window
    const theta = ((i + 0.5) / (2 * half)) * (Math.PI / 2);
    const expected = Math.cos(theta) * l[e + i - half]! + Math.sin(theta) * l[s + i - half]!;
    expect(out[e - half + i]).toBeCloseTo(expected, 6);
    // Power sum of the gains is 1 everywhere
    for (let k = 0; k < 2 * half; k++) {
      const th = ((k + 0.5) / (2 * half)) * (Math.PI / 2);
      expect(Math.cos(th) ** 2 + Math.sin(th) ** 2).toBeCloseTo(1, 12);
    }
  });

  it('a constant-amplitude sine looped on whole periods has no jump at the seam', () => {
    const rate = 44100;
    const freq = 441; // exactly 100 samples per period at 44.1 kHz
    const samples = sine(freq, 4, rate, 0.5);
    const buf = makeBuffer([samples], rate);
    const plan = { regions: [region('a', 1, 2, 5)] }; // 1 s = 441 periods
    const out = renderExtended(buf, plan)[0]!;
    let maxStep = 0;
    for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - 1]!));
    const naturalMaxStep = 0.5 * 2 * Math.PI * (freq / rate);
    // the adaptive crossfade keeps a perfectly matched seam flat: no step above the sine's own slope
    expect(maxStep).toBeLessThan(naturalMaxStep * 1.01);
    // a pure equal-power fade of identical signals swells by up to 3 dB, which shows up as larger steps
    const pure = renderExtended(buf, plan, { adaptiveCrossfade: false })[0]!;
    let pureStep = 0;
    for (let i = 1; i < pure.length; i++) pureStep = Math.max(pureStep, Math.abs(pure[i]! - pure[i - 1]!));
    expect(pureStep).toBeGreaterThan(maxStep * 1.2);
    // and without the crossfade, hard-jumping on the same boundaries is also clean
    const hard = renderExtended(buf, plan, { crossfadeMs: 0 })[0]!;
    let hardStep = 0;
    for (let i = 1; i < hard.length; i++) hardStep = Math.max(hardStep, Math.abs(hard[i]! - hard[i - 1]!));
    expect(hardStep).toBeLessThan(naturalMaxStep * 1.05);
  });

  it('crossfading beats a hard cut when the boundaries do not match', () => {
    const rate = 22050;
    const samples = sine(300, 4, rate, 0.6); // 300 Hz; the region is not a whole number of periods
    const buf = makeBuffer([samples], rate);
    const plan = { regions: [region('a', 1.0, 1.0137, 4)] };
    const maxStep = (x: Float32Array): number => {
      let m = 0;
      for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
      return m;
    };
    const hard = maxStep(renderExtended(buf, plan, { crossfadeMs: 0, snapZeroCrossings: false })[0]!);
    const soft = maxStep(renderExtended(buf, plan, { crossfadeMs: 20, snapZeroCrossings: false })[0]!);
    expect(soft).toBeLessThan(hard);
  });

  it('handles regions at the very start and end of the buffer', () => {
    const l = noise(sr * 2, 8);
    const buf = makeBuffer([l], sr);
    const plan = { regions: [region('a', 0, 0.5, 3), region('b', 1.5, 2, 2)] };
    const exact = renderExtended(buf, plan, { snapZeroCrossings: false })[0]!;
    expect(exact.length).toBe(Math.round((2 + 2 * 0.5 + 0.5) * sr));
    const out = renderExtended(buf, plan)[0]!; // with zero-crossing snapping the edges move a little
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it('works for mono and multichannel, and keeps channels aligned', () => {
    const mono = renderExtended(makeBuffer([noise(2000, 1)], sr), { regions: [region('a', 0.05, 0.15, 2)] });
    expect(mono.length).toBe(1);
    const tri = renderExtended(
      makeBuffer([noise(2000, 1), noise(2000, 2), noise(2000, 3)], sr),
      { regions: [region('a', 0.05, 0.15, 2)] },
    );
    expect(tri.length).toBe(3);
    expect(tri[0]!.length).toBe(tri[2]!.length);
  });

  it('has no 60-minute cap any more: it refuses only what cannot be held in memory, and points at renderRange', () => {
    const buf = makeBuffer([new Float32Array(1000)], 1000); // 1 s at 1 kHz
    expect(() => renderExtended(buf, { regions: [region('a', 0, 1, 64)] }, { crossfadeMs: 0 })).not.toThrow();
    const longish = makeBuffer([new Float32Array(200 * 1000)], 1000); // 200 s
    // 200 s x 64 = 3.5 hours: refused before, fine now
    expect(() => renderExtended(longish, { regions: [region('a', 0, 200, 64)] })).not.toThrow();
    expect(() => renderExtended(longish, { regions: [region('a', 0, 200, 9999)] })).toThrow(/renderRange/);
  });
});

describe('zero-crossing snap', () => {
  it('moves both edges to nearby zero crossings on the mid channel', () => {
    const rate = 44100;
    const s = sine(1000, 1, rate, 0.8);
    const buf = makeBuffer([s, s], rate);
    const r = regionsToSamples(buf, { regions: [region('a', 0.1003, 0.3007, 2)] })[0]!;
    const mid = (i: number): number => s[i]!;
    // each edge sits on a sign change
    for (const idx of [r.start, r.end]) {
      expect(Math.sign(mid(idx - 1)) * Math.sign(mid(idx)) <= 0).toBe(true);
    }
    expect(Math.abs(r.start - Math.round(0.1003 * rate))).toBeLessThanOrEqual(Math.round(0.002 * rate));
    expect(Math.abs(r.end - Math.round(0.3007 * rate))).toBeLessThanOrEqual(Math.round(0.002 * rate));
  });

  it('prefers a crossing with the same slope as the start edge', () => {
    const rate = 44100;
    const s = sine(1000, 1, rate, 0.8);
    const mid = (i: number): number => s[i]!;
    const a = snapToZeroCrossing(mid, s.length, 5000, 40);
    const b = snapToZeroCrossing(mid, s.length, 10000, 60, a.slope);
    expect(b.slope).toBe(a.slope);
  });

  it('leaves the index alone when there is no crossing in range', () => {
    const flat = new Float32Array(1000).fill(0.5);
    expect(snapToZeroCrossing((i) => flat[i]!, 1000, 500, 20).index).toBe(500);
  });

  it('moves stereo channels by the same offset (same sample ranges copied)', () => {
    const rate = 44100;
    const left = sine(997, 2, rate, 0.7);
    const right = sine(1234, 2, rate, 0.5);
    const buf = makeBuffer([left, right], rate);
    const plan = { regions: [region('a', 0.5, 1.0, 2)] };
    const r = regionsToSamples(buf, plan)[0]!;
    const out = renderExtended(buf, plan, { crossfadeMs: 0 });
    // the second repeat of each channel is a copy of the same source range
    const p = r.end - r.start;
    for (let ch = 0; ch < 2; ch++) {
      const src = buf.getChannelData(ch);
      expect(Array.from(out[ch]!.subarray(r.end, r.end + p))).toEqual(Array.from(src.subarray(r.start, r.end)));
    }
  });
});

describe('seam snippets', () => {
  const rate = 8000;
  const song = makeBuffer([noise(rate * 30, 11)], rate);
  const reg = { start: 10, end: 16 };

  it('seam audition is 4 s before + 4 s after the seam and continuous through the crossfade', () => {
    const snip = renderSeamSnippet(song, reg, { crossfadeMs: 0, snapZeroCrossings: false });
    expect(snip.channels[0]!.length).toBe(8 * rate);
    expect(snip.seamIndex).toBe(4 * rate);
    const src = song.getChannelData(0);
    expect(Array.from(snip.channels[0]!.subarray(0, 4 * rate))).toEqual(Array.from(src.subarray(12 * rate, 16 * rate)));
    expect(Array.from(snip.channels[0]!.subarray(4 * rate))).toEqual(Array.from(src.subarray(10 * rate, 14 * rate)));
  });

  it('matches the export renderer around the seam', () => {
    const snip = renderSeamSnippet(song, reg);
    const full = renderExtended(song, { regions: [{ ...reg, id: 'x', repeats: 2, color: '#000' }] });
    const s = regionsToSamples(song, { regions: [{ ...reg, id: 'x', repeats: 2, color: '#000' }] })[0]!;
    const expected = full[0]!.subarray(s.end - 4 * rate, s.end + 4 * rate);
    expect(snip.channels[0]!.length).toBe(expected.length);
    expect(Array.from(snip.channels[0]!)).toEqual(Array.from(expected));
  });

  it('loop body equals one period of the rendered loop and loops seamlessly', () => {
    const plan = { regions: [{ ...reg, id: 'x', repeats: 4, color: '#000' }] };
    const full = renderExtended(song, plan)[0]!;
    const s = regionsToSamples(song, plan)[0]!;
    const body = renderLoopBody(song, reg);
    const period = s.end - s.start;
    expect(body.channels[0]!.length).toBe(period);
    // equals the second repeat of the export render (which contains seam 1 and the start of seam 2)
    expect(Array.from(body.channels[0]!)).toEqual(Array.from(full.subarray(s.end, s.end + period)));
    // and the third repeat too: the loop is periodic
    expect(Array.from(body.channels[0]!)).toEqual(Array.from(full.subarray(s.end + period, s.end + 2 * period)));
    expect(body.originalStart * rate).toBe(s.start);
  });
});

describe('seam plans in the renderer (SPEC-seams.md 3)', () => {
  const rate = 8000;
  const song = makeBuffer([noise(rate * 30, 21)], rate);
  const loop = { start: 10, end: 16 };
  const scores = { transient: 0, spectral: 0, harmony: null, quality: 0 };
  const planOf = (over: Partial<SeamPlan> & { fadeMs?: number; levelDb?: number }): SeamPlan => {
    const shift = over.shift ?? 0;
    const align = over.align ?? 0;
    const from = loop.end + shift + align;
    const to = loop.start + shift;
    return {
      forStart: loop.start,
      forEnd: loop.end,
      smooth: true,
      shift,
      align,
      loopStart: to,
      loopEnd: from,
      jumps: [{ from, to, fadeMs: over.fadeMs, ...(over.levelDb ? { levelDb: over.levelDb, rampSeconds: 0.5 } : {}) }],
      before: scores,
      after: scores,
      bridge: null,
    };
  };
  const reg = (seam?: SeamPlan, repeats = 3) => ({ id: 'x', ...loop, repeats, color: '#000', seam });

  it('a plan that shifts both edges moves what plays, not how long it is', () => {
    const plain = renderExtended(song, { regions: [reg()] }, { snapZeroCrossings: false });
    const rotated = renderExtended(song, { regions: [reg(planOf({ shift: 0.1 }))] }, { snapZeroCrossings: false });
    expect(rotated[0]!.length).toBe(plain[0]!.length);
    expect(extendedDuration({ regions: [reg(planOf({ shift: 0.1 }))] }, 30)).toBeCloseTo(extendedDuration({ regions: [reg()] }, 30), 9);
    // the second pass starts 0.1 s later in the song
    const k = Math.round(16.1 * rate);
    const seamEnd = Math.round(16.1 * rate);
    expect(Array.from(rotated[0]!.subarray(seamEnd + 100, seamEnd + 300))).toEqual(
      Array.from(song.getChannelData(0).subarray(Math.round(10.1 * rate) + 100, Math.round(10.1 * rate) + 300)),
    );
    expect(k).toBeGreaterThan(0);
  });

  it('aligning the end edge changes each repeat by that much, and the timeline knows', () => {
    const plan = { regions: [reg(planOf({ align: 0.012 }), 4)] };
    expect(extendedDuration(plan, 30)).toBeCloseTo(30 + 3 * (6 + 0.012), 9);
    const tl = buildTimeline(plan, 30);
    expect(tl[tl.length - 1]!.outEnd).toBeCloseTo(30 + 3 * (6 + 0.012), 9);
    const out = renderExtended(song, plan, { snapZeroCrossings: false });
    expect(out[0]!.length).toBe(Math.round(30 * rate) + 3 * Math.round(6.012 * rate));
  });

  it('a jump can carry its own fade length', () => {
    const base = { snapZeroCrossings: false, crossfadeMs: 20, adaptiveCrossfade: false } as const;
    const a = renderExtended(song, { regions: [reg(planOf({ fadeMs: 40 }), 2)] }, base)[0]!;
    const b = renderExtended(song, { regions: [reg(undefined, 2)] }, base)[0]!; // the global 20 ms
    const e = 16 * rate;
    const half40 = 160;
    const half20 = 80;
    // both are plain copies outside their windows ...
    expect(a[e - half40 - 1]).toBe(b[e - half40 - 1]);
    expect(a[e + half40]).toBe(b[e + half40]);
    // ... and between the windows the 40 ms fade is still mixing while the 20 ms one has finished
    expect(a[e + half20 + 1]).not.toBe(b[e + half20 + 1]);
  });

  it('a level ramp meets the two sides at one level, and only on the repeats that jump back', () => {
    const tone = sine(440, 30, rate, 0.5);
    const buf = makeBuffer([tone], rate);
    const plan = planOf({ levelDb: -6 });
    const out = renderExtended(buf, { regions: [{ ...reg(plan, 3) }] }, { snapZeroCrossings: false })[0]!;
    const rms = (x: Float32Array, a: number, b: number): number => {
      let s = 0;
      for (let i = a; i < b; i++) s += x[i]! * x[i]!;
      return Math.sqrt(s / (b - a));
    };
    const w = Math.round(0.04 * rate);
    const seam1 = 16 * rate;
    // just before the first seam's 20 ms window the level has come down to about the ramp's end gain (6 dB, 0.5)
    const w10 = Math.round(0.01 * rate);
    const near = rms(out, seam1 - 3 * w10, seam1 - w10) / rms(tone, 10 * rate, 10 * rate + 2 * w10);
    expect(near).toBeGreaterThan(10 ** (-6 / 20) - 0.01);
    expect(near).toBeLessThan(0.54);
    // a beat earlier it was untouched (ramp is a beat long)
    expect(rms(out, seam1 - rate, seam1 - rate + w) / rms(tone, 15 * rate, 15 * rate + w)).toBeCloseTo(1, 1);
    // the last repeat leaves the loop untouched and flows into the rest of the song
    const lastEnd = 28 * rate;
    expect(rms(out, lastEnd - w, lastEnd)).toBeCloseTo(rms(tone, 16 * rate - w, 16 * rate), 3);
  });

  it('ignores a plan computed for other points', () => {
    const stale = { ...planOf({ shift: 0.1 }), forStart: 9.9 };
    const a = renderExtended(song, { regions: [reg(stale)] });
    const b = renderExtended(song, { regions: [reg()] });
    expect(Array.from(a[0]!)).toEqual(Array.from(b[0]!));
    expect(planKey({ regions: [reg(stale)] }, 30, 20)).toBe(planKey({ regions: [reg()] }, 30, 20));
    expect(planKey({ regions: [reg(planOf({ shift: 0.1 }))] }, 30, 20)).not.toBe(planKey({ regions: [reg()] }, 30, 20));
  });

  it('ignores a plan that would leave the song or run into the loop before it', () => {
    const early = planOf({ shift: -12 });
    const a = renderExtended(song, { regions: [reg(early)] });
    const b = renderExtended(song, { regions: [reg()] });
    expect(Array.from(a[0]!)).toEqual(Array.from(b[0]!));
    const prev = { id: 'p', start: 2, end: 9.95, repeats: 2, color: '#000' };
    const crowd = planOf({ shift: -0.2 });
    const c = renderExtended(song, { regions: [prev, reg(crowd)] });
    const d = renderExtended(song, { regions: [prev, reg()] });
    expect(Array.from(c[0]!)).toEqual(Array.from(d[0]!));
  });

  it('seam audition, loop preview and export agree with a plan (rotation, alignment, fade and level)', () => {
    const plan = planOf({ shift: -0.03, align: 0.007, fadeMs: 40, levelDb: -3 });
    const region = { ...loop, seam: plan };
    const full = renderExtended(song, { regions: [reg(plan, 4)] })[0]!;
    const s = regionsToSamples(song, { regions: [reg(plan, 4)] })[0]!;
    // the seam audition equals the export around its first seam
    const snip = renderSeamSnippet(song, region);
    const around = full.subarray(s.end - 4 * rate, s.end + 4 * rate);
    expect(Array.from(snip.channels[0]!)).toEqual(Array.from(around));
    // the loop body equals the second and third repeat of the export
    const body = renderLoopBody(song, region);
    const period = s.end - s.start;
    expect(body.channels[0]!.length).toBe(period);
    expect(Array.from(body.channels[0]!)).toEqual(Array.from(full.subarray(s.end, s.end + period)));
    expect(Array.from(body.channels[0]!)).toEqual(Array.from(full.subarray(s.end + period, s.end + 2 * period)));
  });
});

describe('Undo (SPEC-seams.md 3.5)', () => {
  it('restores the original points exactly, turns smoothing off and plays like the plain loop', () => {
    const plan: SeamPlan = {
      forStart: 12.3456789,
      forEnd: 24.6913578,
      smooth: true,
      shift: -0.061,
      align: 0.007,
      loopStart: 12.3456789 - 0.061,
      loopEnd: 24.6913578 - 0.061 + 0.007,
      jumps: [{ from: 24.6913578 - 0.061 + 0.007, to: 12.3456789 - 0.061, fadeMs: 40 }],
      before: { transient: 0, spectral: 0, harmony: null, quality: 0 },
      after: { transient: 0, spectral: 0, harmony: null, quality: 0 },
      bridge: null,
    };
    const original = { id: 'a', start: 12.3456789, end: 24.6913578, repeats: 3, color: '#123456', snapToBars: true };
    const smoothed = withSeamPlan(original, plan);
    expect(smoothed.seam).toBe(plan);
    expect(isSmooth(smoothed)).toBe(true);
    const undone = undoSmoothing(smoothed);
    expect(undone.start).toBe(original.start);
    expect(undone.end).toBe(original.end);
    expect(undone.seam).toBeUndefined();
    expect(isSmooth(undone)).toBe(false);
    expect(undone).toEqual({ ...original, smooth: false });
    // and it plays like the plain loop
    expect(buildTimeline({ regions: [undone] }, 40)).toEqual(buildTimeline({ regions: [original] }, 40));
    // a plan for other points is not attached
    expect(withSeamPlan({ ...original, start: 13 }, plan).seam).toBeUndefined();
  });
});
