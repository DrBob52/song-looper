import { describe, expect, it } from 'vitest';
import type { Cut, LoopRegion, SeamPlan } from '../../src/model';
import type { Plan } from '../../src/model';
import { PlanParts, RangeRenderer, planExtras, regionParts, regionsToSamples, renderExtended, renderRange } from '../../src/audio/render';
import type { Part, RenderOptions } from '../../src/audio/render';
import type { AudioBufferLike } from '../../src/audio/types';
import { makeBuffer } from '../../src/audio/types';
import { referenceRenderExtended } from './referenceRender';

// SPEC-v1.2.md 2.2: renderRange equals the same slice of the full render, bit for bit.

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

/** Deterministic random numbers in [0, 1). */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const scores = { transient: 0, spectral: 0, harmony: null, quality: 0 };

/** A seam plan for a loop with a bridge: jumps leave at `from` and land on `to`; the last lands on the loop start. */
function bridged(start: number, end: number, jumps: { from: number; to: number; fadeMs?: number; levelDb?: number; rampSeconds?: number }[]): SeamPlan {
  return {
    forStart: start,
    forEnd: end,
    smooth: true,
    shift: 0,
    align: 0,
    loopStart: start,
    loopEnd: end,
    jumps,
    before: scores,
    after: scores,
    bridge: { bars: 2, seconds: 1, from: end, chordChangeAt: end, worstHarmony: 0.9, jumps: jumps.length },
  };
}

const region = (id: string, start: number, end: number, repeats: number, seam?: SeamPlan): LoopRegion => ({
  id,
  start,
  end,
  repeats,
  color: '#000',
  ...(seam ? { seam } : {}),
});

function same(a: Float32Array[], b: Float32Array[], what: string): void {
  expect(a.length, `${what}: channels`).toBe(b.length);
  for (let c = 0; c < a.length; c++) {
    expect(a[c]!.length, `${what}: length`).toBe(b[c]!.length);
    const x = Buffer.from(a[c]!.buffer, a[c]!.byteOffset, a[c]!.byteLength);
    const y = Buffer.from(b[c]!.buffer, b[c]!.byteOffset, b[c]!.byteLength);
    if (!x.equals(y)) {
      let i = 0;
      while (i < a[c]!.length && a[c]![i] === b[c]![i]) i++;
      throw new Error(`${what}: channel ${c} differs from sample ${i} (${a[c]![i]} vs ${b[c]![i]})`);
    }
  }
}

/** Compare `trials` random ranges (plus the edges and every seam) of a plan with the same slices of the reference render. */
function checkPlan(buffer: AudioBufferLike, plan: Plan, options: RenderOptions, trials: number, seed: number): void {
  const full = referenceRenderExtended(buffer, plan, options);
  const total = full[0]!.length;
  const renderer = new RangeRenderer(buffer, plan, options);
  expect(renderer.total).toBe(total);
  const slice = (from: number, length: number): Float32Array[] => {
    const a = Math.max(0, Math.min(total, from));
    const b = Math.max(a, Math.min(total, from + length));
    return full.map((c) => c.subarray(a, b));
  };
  const check = (from: number, length: number): void => same(renderer.render(from, length), slice(from, length), `range [${from}, +${length})`);

  // the whole thing, the edges, empty and absurd ranges
  check(0, total);
  check(0, 1);
  check(total - 1, 1);
  check(total - 5000, 100000);
  check(0, 0);
  check(total, 10);
  check(total + 100, 10);
  check(-50, 100);
  // ranges around every jump: the seam sample, a little before and after it
  const access = new PlanParts(regionsToSamples(buffer, plan, options), buffer.length, buffer.sampleRate, options, planExtras(buffer, plan, options));
  const seams: number[] = [];
  for (let i = 1; i < access.count; i++) if (access.part(i).jump) seams.push(access.startOf(i));
  const rand = rng(seed);
  const stride = Math.max(1, Math.floor(seams.length / 40));
  for (let k = 0; k < seams.length; k += stride) {
    const s = seams[k]!;
    for (const [before, after] of [[0, 1], [1, 0], [3, 3], [200, 200], [Math.floor(rand() * 3000), Math.floor(rand() * 3000)]] as const) {
      check(s - before, before + after);
    }
  }
  // random ranges, short and long, straddling whatever is there
  for (let t = 0; t < trials; t++) {
    const len = Math.floor(rand() ** 3 * Math.min(total, 60000)) + 1;
    check(Math.floor(rand() * total) - Math.floor(len / 2), len);
  }
  // consecutive pieces (the way the export walks) join into the full render
  const chunk = 7777;
  for (let c = 0; c < full.length; c++) {
    const joined = new Float32Array(total);
    for (let pos = 0; pos < total; pos += chunk) joined.set(renderer.render(pos, chunk)[c]!, pos);
    expect(Buffer.from(joined.buffer).equals(Buffer.from(full[c]!.buffer, full[c]!.byteOffset, full[c]!.byteLength))).toBe(true);
  }
}

describe('renderRange equals a slice of the full render', () => {
  const sr = 8000;
  const song = makeBuffer([noise(sr * 30, 21), noise(sr * 30, 22)], sr);

  it('a plain loop (crossfade, zero-crossing snap)', () => {
    checkPlan(song, { regions: [region('a', 10, 16, 5)] }, {}, 60, 1);
  });

  it('with no crossfade, no snapping, pure equal-power fades', () => {
    const plan = { regions: [region('a', 10.25, 16.5, 4)] };
    checkPlan(song, plan, { crossfadeMs: 0, snapZeroCrossings: false }, 25, 2);
    checkPlan(song, plan, { crossfadeMs: 80, snapZeroCrossings: false, adaptiveCrossfade: false }, 25, 3);
  });

  it('one repeat is the song itself, and ranges of it', () => {
    checkPlan(song, { regions: [region('a', 5, 9, 1), region('b', 12, 20, 1)] }, {}, 15, 4);
    checkPlan(song, { regions: [] }, {}, 10, 5);
  });

  it('several loops, a seam plan with rotation, alignment, its own fade and a level ramp, and a bridge', () => {
    const smooth: SeamPlan = {
      forStart: 4,
      forEnd: 9,
      smooth: true,
      shift: 0.2,
      align: 0.004,
      loopStart: 4.2,
      loopEnd: 9.2,
      jumps: [{ from: 9.204, to: 4.2, fadeMs: 40, levelDb: -2.5, rampSeconds: 0.5 }],
      before: scores,
      after: scores,
      bridge: null,
    };
    // loop 2: 15 -> 20, a bridge on to 22.5, jump back to 17, on to 18.2, jump back to the start (3 pieces' worth of jumps)
    const bridge = bridged(15, 20, [
      { from: 22.5, to: 17, fadeMs: 30 },
      { from: 18.2, to: 15, fadeMs: 55, levelDb: 3, rampSeconds: 0.25 },
    ]);
    const plan = { regions: [region('a', 4, 9, 6, smooth), region('b', 15, 20, 5, bridge), region('c', 24, 29.9, 3)] };
    checkPlan(song, plan, {}, 120, 6);
    checkPlan(song, plan, { crossfadeMs: 5, snapZeroCrossings: false }, 40, 7);
  });

  it('short pieces with a long fade and a ramp longer than the piece (windows overlap)', () => {
    const tiny = bridged(6, 6.2, [
      { from: 6.35, to: 6.1, fadeMs: 80 },
      { from: 6.15, to: 6, fadeMs: 80, levelDb: -4, rampSeconds: 1.5 },
    ]);
    checkPlan(song, { regions: [region('a', 6, 6.2, 60, tiny), region('b', 20, 20.05, 80)] }, {}, 80, 8);
  });

  it('loops touching the start and the end of the song, where fades read silence beyond the edges', () => {
    checkPlan(song, { regions: [region('a', 0, 3, 4), region('b', 27, 30, 4)] }, {}, 40, 9);
  });

  it('mono and three channels', () => {
    const mono = makeBuffer([noise(sr * 12, 31)], sr);
    checkPlan(mono, { regions: [region('a', 3, 6, 7)] }, {}, 30, 10);
    const tri = makeBuffer([noise(sr * 12, 41), noise(sr * 12, 42), noise(sr * 12, 43)], sr);
    checkPlan(tri, { regions: [region('a', 2, 5, 3), region('b', 7, 11, 3)] }, {}, 30, 11);
  });

  it('is the same as renderExtended, which now shares its code', () => {
    const plan = { regions: [region('a', 10, 16, 5)] };
    same(renderExtended(song, plan), referenceRenderExtended(song, plan), 'renderExtended');
    same(renderRange(song, plan, 123456, 4321), referenceRenderExtended(song, plan).map((c) => c.subarray(123456, 123456 + 4321)), 'renderRange');
  });
});

describe('renderRange equals a slice of the full render with cuts and an ending (SPEC-v1.3.md 2 and 3)', () => {
  const sr = 8000;
  const song = makeBuffer([noise(sr * 30, 21), noise(sr * 30, 22)], sr);
  const cut = (id: string, start: number, end: number): Cut => ({ id, start, end });
  const smooth: SeamPlan = {
    forStart: 4,
    forEnd: 9,
    smooth: true,
    shift: 0.2,
    align: 0.004,
    loopStart: 4.2,
    loopEnd: 9.2,
    jumps: [{ from: 9.204, to: 4.2, fadeMs: 40, levelDb: -2.5, rampSeconds: 0.5 }],
    before: scores,
    after: scores,
    bridge: null,
  };

  it('a cut in the middle of the plain song', () => {
    const plan = { regions: [], cuts: [cut('c', 12, 14)] };
    checkPlan(song, plan, {}, 60, 21);
    checkPlan(song, plan, { crossfadeMs: 40, snapZeroCrossings: false }, 30, 22);
    checkPlan(song, plan, { crossfadeMs: 80, snapZeroCrossings: false, adaptiveCrossfade: false }, 30, 23);
  });

  it('several cuts, one right after another (merged), and tiny pieces between cuts', () => {
    checkPlan(song, { regions: [], cuts: [cut('a', 5, 6), cut('b', 6, 8), cut('c', 8.01, 9), cut('d', 9.012, 12), cut('e', 15, 15.05)] }, {}, 60, 24);
  });

  it('a cut at the very start (a fade-in), at the very end (a fade-out), and both', () => {
    checkPlan(song, { regions: [], cuts: [cut('a', 0, 3)] }, {}, 40, 25);
    checkPlan(song, { regions: [], cuts: [cut('a', 27, 30)] }, {}, 40, 26);
    checkPlan(song, { regions: [], cuts: [cut('a', 0, 3), cut('b', 27, 30), cut('c', 14, 15)] }, {}, 60, 27);
  });

  it('loops with cuts around them: next to a loop edge, between loops, and with a bridge and a seam plan', () => {
    const bridge = bridged(15, 20, [
      { from: 22.5, to: 17, fadeMs: 30 },
      { from: 18.2, to: 15, fadeMs: 55, levelDb: 3, rampSeconds: 0.25 },
    ]);
    const plan = {
      regions: [region('a', 4, 9, 6, smooth), region('b', 15, 20, 5, bridge), region('c', 24, 29.9, 3)],
      // a leading cut; right after loop a; right before loop b; between b's bridge and c; to the end of the song
      cuts: [cut('1', 0, 2), cut('2', 9.2, 11), cut('3', 13, 15), cut('4', 23, 23.5), cut('5', 29.9, 30)],
    };
    checkPlan(song, plan, {}, 150, 28);
    checkPlan(song, plan, { crossfadeMs: 5, snapZeroCrossings: false }, 50, 29);
  });

  it('a cut between two loops that touch it on both sides, and a cut that ends where the first loop starts', () => {
    checkPlan(song, { regions: [region('a', 10, 15, 3), region('b', 17, 22, 3)], cuts: [cut('c', 15, 17)] }, {}, 80, 30);
    checkPlan(song, { regions: [region('a', 4, 9, 4)], cuts: [cut('c', 0, 4)] }, {}, 60, 31);
    checkPlan(song, { regions: [region('a', 0, 3, 2), region('b', 5, 8, 2)], cuts: [cut('c', 3, 5)] }, {}, 60, 32);
  });

  it('a cut that overlaps a loop is trimmed to the free song around it', () => {
    checkPlan(song, { regions: [region('a', 10, 15, 3)], cuts: [cut('c', 8, 12), cut('d', 14, 18)] }, {}, 60, 33);
  });

  it('the ending: End at inside a repeat, with and without a fade, past the end, and a fade on the real ending', () => {
    const loop = [region('a', 10, 16, 5)];
    checkPlan(song, { regions: loop, ending: { endAt: 41.5, fadeSeconds: 3 } }, {}, 60, 34);
    checkPlan(song, { regions: loop, ending: { endAt: 41.5, fadeSeconds: 0 } }, {}, 40, 35);
    checkPlan(song, { regions: loop, ending: { endAt: 9999, fadeSeconds: 2 } }, {}, 40, 36);
    checkPlan(song, { regions: loop, ending: { endAt: null, fadeSeconds: 4 } }, {}, 40, 37);
    // the fade is longer than what is left of the song: it is cut to the song
    checkPlan(song, { regions: loop, ending: { endAt: 2, fadeSeconds: 5 } }, {}, 30, 38);
  });

  it('the ending together with cuts and loops (the fade crosses a cut join and a seam)', () => {
    const plan = {
      regions: [region('a', 10, 16, 5)],
      cuts: [cut('c', 3, 5), cut('d', 18, 20), cut('e', 28, 30)],
      ending: { endAt: 52.25, fadeSeconds: 40 },
    };
    checkPlan(song, plan, {}, 80, 39);
    checkPlan(song, { ...plan, ending: { endAt: null, fadeSeconds: 0 } }, {}, 40, 40);
  });

  it('is the same as renderExtended, which lists the parts instead of finding them', () => {
    const plan = { regions: [region('a', 10, 16, 3)], cuts: [cut('c', 0, 2), cut('d', 20, 22), cut('e', 29, 30)], ending: { endAt: 30, fadeSeconds: 1.5 } };
    const full = renderExtended(song, plan);
    same(full, referenceRenderExtended(song, plan), 'renderExtended with cuts');
    same(renderRange(song, plan, 1234, 5678), full.map((c) => c.subarray(1234, 1234 + 5678)), 'renderRange with cuts');
  });
});

describe('PlanParts finds parts without listing them', () => {
  const sr = 8000;
  const song = makeBuffer([noise(sr * 30, 21)], sr);
  const bridge = bridged(15, 20, [
    { from: 22.5, to: 17 },
    { from: 18.2, to: 15 },
  ]);
  const plan = { regions: [region('a', 4, 9, 6), region('b', 15, 20, 5, bridge), region('c', 24, 29.9, 1)] };
  const regions = regionsToSamples(song, plan);
  const access = new PlanParts(regions, song.length, sr);
  const list: Part[] = [];
  let cursor = 0;
  for (const r of regions) {
    list.push(...regionParts(r, cursor));
    cursor = r.end;
  }
  list.push({ start: cursor, end: song.length });

  it('has the same parts, in the same places, as the list', () => {
    expect(access.count).toBe(list.length);
    let out = 0;
    for (let i = 0; i < list.length; i++) {
      expect(access.part(i), `part ${i}`).toEqual(list[i]);
      expect(access.startOf(i), `start of ${i}`).toBe(out);
      out += list[i]!.end - list[i]!.start;
    }
    expect(access.total).toBe(out);
  });

  it('indexAt is the last part starting at or before a position', () => {
    const starts = list.map((_, i) => access.startOf(i));
    const rand = rng(5);
    const probes = [0, 1, access.total - 1, access.total, access.total + 5, ...starts, ...starts.map((s) => s - 1), ...starts.map((s) => s + 1)];
    for (let k = 0; k < 500; k++) probes.push(Math.floor(rand() * access.total));
    for (const pos of probes) {
      let want = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i]! <= pos) want = i;
      expect(access.indexAt(pos), `at ${pos}`).toBe(want);
    }
  });
});

describe('very many repeats', () => {
  const sr = 8000;
  const song = makeBuffer([noise(sr * 30, 21)], sr);

  it('9,999 repeats: the length is exact, and every middle cycle plays alike', () => {
    const plan = { regions: [region('a', 10, 12, 9999)] };
    const r = new RangeRenderer(song, plan);
    const s = regionsToSamples(song, plan)[0]!;
    const cycle = s.end - s.start;
    expect(r.total).toBe(song.length + 9998 * cycle);
    const seamLike = 12345;
    const early = r.render(s.start + 5 * cycle + seamLike, 5000)[0]!;
    const late = r.render(s.start + 9000 * cycle + seamLike, 5000)[0]!;
    expect(Buffer.from(early.buffer).equals(Buffer.from(late.buffer))).toBe(true);
    // a range across the seam of a late cycle equals one across an early seam
    const a = r.render(s.start + 6 * cycle - 300, 600)[0]!;
    const b = r.render(s.start + 9500 * cycle - 300, 600)[0]!;
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    // and the final repeat plays on into the rest of the song
    const tail = r.render(r.total - 4000, 4000)[0]!;
    expect(Buffer.from(tail.buffer).equals(Buffer.from(Float32Array.from(song.getChannelData(0).subarray(song.length - 4000)).buffer))).toBe(true);
  });

  it('renders far into a plan that would be 6 hours long without building it', () => {
    const loopSong = makeBuffer([noise(sr * 20, 3)], sr);
    const plan = { regions: [region('a', 2, 10, 9999)] };
    const r = new RangeRenderer(loopSong, plan);
    expect(r.total / sr).toBeGreaterThan(79_000);
    const t0 = performance.now();
    const piece = r.render(Math.floor(r.total / 2), 10 * sr)[0]!;
    expect(piece.length).toBe(10 * sr);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('renderExtended is for what fits in memory', () => {
  it('has no 60-minute cap, only a limit on frames held at once', () => {
    const buf = makeBuffer([new Float32Array(1000)], 1000); // 1 s at 1 kHz
    // 4 hours would have been refused before; this is fine
    expect(() => renderExtended(buf, { regions: [region('a', 0, 1, 64)] }, { crossfadeMs: 0 })).not.toThrow();
    const longish = makeBuffer([new Float32Array(200 * 1000)], 1000); // 200 s
    expect(() => renderExtended(longish, { regions: [region('a', 0, 200, 64)] })).not.toThrow();
    // what cannot be held in memory points at renderRange instead
    expect(() => renderExtended(longish, { regions: [region('a', 0, 200, 9999)] })).toThrow(/renderRange/);
    // the same plan is no problem for renderRange
    expect(renderRange(longish, { regions: [region('a', 0, 200, 9999)] }, 5_000_000, 1000)[0]!.length).toBe(1000);
  });
});
