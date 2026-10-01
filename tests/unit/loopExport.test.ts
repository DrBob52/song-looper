import { describe, expect, it } from 'vitest';
import type { LoopRegion, SeamPlan } from '../../src/model';
import { MAX_REPEATS } from '../../src/model';
import { ExportCancelled, exportWavPieces } from '../../src/audio/exportPieces';
import type { ExportHooks, ExportJob } from '../../src/audio/exportPieces';
import { LOOP_READY_MIN_MS, LoopFileRenderer, loopFileLayout, loopFileName, loopFilePlan } from '../../src/audio/loopExport';
import { renderRange } from '../../src/audio/render';
import { makeBuffer } from '../../src/audio/types';
import { encodeWavBytes } from '../../src/audio/wav';
import { sanitizeFilename } from '../../src/util/filename';

// SPEC-v1.3.md 7.1: a loop as a file of its own. The file is `renderRange` over a plan with just that loop (so it is what
// the preview plays); loop-ready makes the file loop end-to-start without a jump.

const SR = 22050;
const scores = { transient: 0, spectral: 0, harmony: null, quality: 0 };

/** A chord-like stereo song: three partials per channel that never line up with a loop's length. */
function song(seconds = 12) {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    left[i] = 0.25 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 331 * t + 1) + 0.15 * Math.sin(2 * Math.PI * 523 * t);
    right[i] = 0.22 * Math.sin(2 * Math.PI * 220.5 * t + 0.3) + 0.2 * Math.sin(2 * Math.PI * 330 * t) + 0.15 * Math.sin(2 * Math.PI * 524 * t + 2);
  }
  return makeBuffer([left, right], SR);
}

const maxStep = (x: Float32Array, from = 1, to = x.length): number => {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
};

const loop = (start: number, end: number, extra: Partial<LoopRegion> = {}): LoopRegion => ({ id: 'a', start, end, repeats: 3, color: '#000', ...extra });

/** A smoothed seam: both edges moved by `shift`, the cycle leaves `align` later than the loop's end. */
function smoothSeam(start: number, end: number, shift: number, align: number, fadeMs = 40): SeamPlan {
  return {
    forStart: start,
    forEnd: end,
    smooth: true,
    shift,
    align,
    loopStart: start + shift,
    loopEnd: end + shift,
    jumps: [{ from: end + shift + align, to: start + shift, fadeMs }],
    before: scores,
    after: scores,
    bridge: null,
  };
}

/** A seam with a bridge of 1 s after the loop end (one jump from the end of the bridge back to the start). */
function bridgedSeam(start: number, end: number): SeamPlan {
  return {
    forStart: start,
    forEnd: end,
    smooth: true,
    shift: 0,
    align: 0,
    loopStart: start,
    loopEnd: end,
    jumps: [{ from: end + 1, to: start, fadeMs: 40 }],
    before: scores,
    after: scores,
    bridge: { bars: 2, seconds: 1, from: end, chordChangeAt: end + 1, worstHarmony: 0.9, jumps: 1 },
  };
}

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

describe('loopFilePlan: just this loop, played as it is, without a bridge, cuts or ending', () => {
  it('has one loop with N repeats (1 to 9,999) and nothing else', () => {
    const plan = loopFilePlan(loop(2, 5), 4);
    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]!.repeats).toBe(4);
    expect(plan.cuts).toBeUndefined();
    expect(plan.ending).toBeUndefined();
    expect(loopFilePlan(loop(2, 5), 0).regions[0]!.repeats).toBe(1);
    expect(loopFilePlan(loop(2, 5), 123456).regions[0]!.repeats).toBe(MAX_REPEATS);
  });

  it('keeps the smoothed span and the plan of a loop without a bridge', () => {
    const seam = smoothSeam(3, 6, 0.1, 0.004);
    const r = loopFilePlan(loop(3, 6, { seam }), 2).regions[0]!;
    expect(r.seam).toEqual(seam);
    expect(r.bridge).toBe(false);
  });

  it('leaves the bridge out: the rotated span stays, the passes join by a plain jump from its end back to its start', () => {
    const r = loopFilePlan(loop(3, 6, { bridge: true, seam: bridgedSeam(3, 6) }), 2).regions[0]!;
    expect(r.bridge).toBe(false);
    expect(r.seam!.bridge).toBeNull();
    expect(r.seam!.jumps).toEqual([{ from: 6, to: 3 }]);
    const rotated = { ...bridgedSeam(3, 6), shift: 0.2, loopStart: 3.2, loopEnd: 6.2 };
    const r2 = loopFilePlan(loop(3, 6, { bridge: true, seam: rotated }), 2).regions[0]!;
    expect(r2.seam!.jumps).toEqual([{ from: 6.2, to: 3.2 }]);
  });

  it('does not change the loop it was made from', () => {
    const original = loop(3, 6, { bridge: true, seam: bridgedSeam(3, 6) });
    const copy = structuredClone(original);
    loopFilePlan(original, 5);
    expect(original).toEqual(copy);
  });
});

describe('the file is the matching span of renderRange for a plan with just that loop', () => {
  const buf = song();
  const cases: [string, LoopRegion][] = [
    ['a plain loop', loop(3.123, 6.789)],
    ['a loop with a smoothed seam (rotated, aligned, its own fade)', loop(3.123, 6.789, { seam: smoothSeam(3.123, 6.789, 0.11, 0.006, 60) })],
    ['a loop with a bridge (left out of the file)', loop(3.123, 6.789, { bridge: true, seam: bridgedSeam(3.123, 6.789) })],
    ['a loop at the very start of the song', loop(0, 2.5)],
    ['a loop that runs to the very end of the song', loop(9.4, 12)],
  ];
  for (const [name, region] of cases) {
    for (const repeats of [1, 2, 4, 7]) {
      it(`${name}, ${repeats} repeat${repeats === 1 ? '' : 's'}: bit for bit, with loop-ready off`, () => {
        const plan = loopFilePlan(region, repeats);
        const layout = loopFileLayout(buf, region);
        const frames = layout.frames(repeats);
        const file = new LoopFileRenderer(buf, plan, { loopReady: false });
        expect(file.total).toBe(frames);
        expect(file.wrapFrames).toBe(0);
        const expected = renderRange(buf, plan, layout.start, frames);
        same(file.render(0, frames), expected, `${name} x${repeats}`);
      });
    }
  }

  it('a loop without a bridge is as long as repeats x the loop; a bridged one is not longer for its bridge', () => {
    const plain = loopFileLayout(buf, loop(3, 6));
    expect(plain.cycle).toBe(plain.end - plain.start);
    expect(plain.frames(4)).toBe(4 * (plain.end - plain.start));
    const bridged = loopFileLayout(buf, loop(3, 6, { bridge: true, seam: bridgedSeam(3, 6) }));
    expect(bridged.frames(4)).toBe(4 * (bridged.end - bridged.start));
    // a smoothed seam that leaves 6 ms after the loop's end plays that much more on every repeat but the last
    const aligned = loopFileLayout(buf, loop(3, 6, { seam: smoothSeam(3, 6, 0, 0.006) }));
    expect(aligned.cycle - (aligned.end - aligned.start)).toBeGreaterThan(Math.round(0.005 * SR));
    expect(aligned.frames(4)).toBe(3 * aligned.cycle + (aligned.end - aligned.start));
  });

  it('pieces of any size join into the whole file (the export writes it a piece at a time)', () => {
    const region = loop(3.123, 6.789, { seam: smoothSeam(3.123, 6.789, 0.11, 0.006, 60) });
    const file = new LoopFileRenderer(buf, loopFilePlan(region, 5), { crossfadeMs: 30, loopReady: true });
    const whole = file.render(0, file.total);
    for (const size of [997, 4410, 22050]) {
      const joined = [new Float32Array(file.total), new Float32Array(file.total)];
      for (let pos = 0; pos < file.total; pos += size) {
        const piece = file.render(pos, size);
        piece.forEach((c, i) => joined[i]!.set(c, pos));
      }
      same(joined, whole, `pieces of ${size}`);
    }
  });
});

describe('loop-ready: the end of the file crossfades into the song just before the loop', () => {
  const buf = song();
  const region = loop(3.123, 6.789);
  const layout = loopFileLayout(buf, region);

  it('W is the Seam fade setting, and never under 10 ms', () => {
    const wrap = (crossfadeMs: number): number => new LoopFileRenderer(buf, loopFilePlan(region, 1), { crossfadeMs, loopReady: true }).wrapFrames;
    expect(LOOP_READY_MIN_MS).toBe(10);
    expect(wrap(20)).toBe(2 * Math.floor(0.02 * SR * 0.5));
    expect(wrap(40)).toBe(2 * Math.floor(0.04 * SR * 0.5));
    expect(wrap(80)).toBe(2 * Math.floor(0.08 * SR * 0.5));
    expect(wrap(5)).toBe(wrap(10));
    expect(wrap(0)).toBe(wrap(10));
    expect(wrap(0)).toBe(2 * Math.floor(0.01 * SR * 0.5));
    // the default is the app's Seam fade default (20 ms)
    expect(new LoopFileRenderer(buf, loopFilePlan(region, 1)).wrapFrames).toBe(wrap(20));
    // off: no crossfade
    expect(new LoopFileRenderer(buf, loopFilePlan(region, 1), { loopReady: false }).wrapFrames).toBe(0);
  });

  it('changes only the last W samples: everything before them is the plain file', () => {
    for (const repeats of [1, 3]) {
      const plan = loopFilePlan(region, repeats);
      const off = new LoopFileRenderer(buf, plan, { crossfadeMs: 40, loopReady: false });
      const on = new LoopFileRenderer(buf, plan, { crossfadeMs: 40, loopReady: true });
      expect(on.total).toBe(off.total);
      const a = on.render(0, on.total);
      const b = off.render(0, off.total);
      const head = on.total - on.wrapFrames;
      for (let c = 0; c < a.length; c++) {
        expect(Buffer.from(a[c]!.buffer, 0, head * 4).equals(Buffer.from(b[c]!.buffer, 0, head * 4))).toBe(true);
        let differs = 0;
        for (let i = head; i < on.total; i++) if (a[c]![i] !== b[c]![i]) differs++;
        expect(differs).toBeGreaterThan(on.wrapFrames * 0.9);
      }
    }
  });

  it('is equal-power from the end of the loop to the song before its start (pure law, no adaptive blend)', () => {
    const file = new LoopFileRenderer(buf, loopFilePlan(region, 2), { crossfadeMs: 40, adaptiveCrossfade: false, loopReady: true });
    const out = file.render(0, file.total);
    const w = file.wrapFrames;
    const tail = file.total - w;
    for (let c = 0; c < 2; c++) {
      const src = buf.getChannelData(c);
      let worst = 0;
      for (let k = 0; k < w; k++) {
        const theta = ((k + 0.5) / w) * (Math.PI / 2);
        const expected = Math.cos(theta) * src[layout.end - w + k]! + Math.sin(theta) * src[layout.start - w + k]!;
        worst = Math.max(worst, Math.abs(out[c]![tail + k]! - expected));
      }
      expect(worst).toBeLessThan(1e-6);
    }
  });

  it('a loop-ready file joined to itself has no jump at the join; a plain file has a big one', () => {
    const natural = maxStep(buf.getChannelData(0));
    for (const repeats of [1, 4]) {
      for (const crossfadeMs of [20, 5, 80]) {
        const plan = loopFilePlan(region, repeats);
        const ready = new LoopFileRenderer(buf, plan, { crossfadeMs, loopReady: true });
        const plain = new LoopFileRenderer(buf, plan, { crossfadeMs, loopReady: false });
        const a = ready.render(0, ready.total)[0]!;
        const b = plain.render(0, plain.total)[0]!;
        // the file repeated end-to-start, as a sampler does
        const joined = new Float32Array(a.length * 2);
        joined.set(a, 0);
        joined.set(a, a.length);
        const joinedPlain = new Float32Array(b.length * 2);
        joinedPlain.set(b, 0);
        joinedPlain.set(b, b.length);
        const at = a.length;
        const jump = Math.abs(joined[at]! - joined[at - 1]!);
        const around = maxStep(joined, at - ready.wrapFrames - 2, at + ready.wrapFrames + 2);
        const hard = Math.abs(joinedPlain[at]! - joinedPlain[at - 1]!);
        console.warn(`loop-ready x${repeats} W=${(ready.wrapFrames / SR * 1000).toFixed(1)} ms: join jump ${jump.toFixed(5)}, max step within +-W ${around.toFixed(5)}, song's own max step ${natural.toFixed(5)} (jump/natural ${(jump / natural).toFixed(3)}, around/natural ${(around / natural).toFixed(3)}); plain file's jump ${hard.toFixed(5)}`);
        // the join is as smooth as the song itself, and so is everything within a window either side of it
        expect(jump).toBeLessThan(natural * 1.05);
        expect(around).toBeLessThan(natural * 1.5);
        // without it the file jumps, and by more than the song itself ever steps (this loop's edges do not match)
        expect(hard).toBeGreaterThan(natural * 1.5);
        expect(hard).toBeGreaterThan(jump * 5);
      }
    }
  });

  it('the join is the song itself: the last samples are the song just before the loop, the next is the loop\'s first', () => {
    const file = new LoopFileRenderer(buf, loopFilePlan(region, 1), { crossfadeMs: 20, loopReady: true });
    const out = file.render(0, file.total);
    const src = buf.getChannelData(0);
    const last = out[0]![file.total - 1]!;
    // the wrap window ends almost entirely on the song before the loop (the loop's own end has a weight under 0.2 %)
    expect(Math.abs(last - src[layout.start - 1]!)).toBeLessThan(0.002);
    expect(out[0]![0]).toBe(src[layout.start]);
  });

  it('where the song does not reach back W samples (a loop at its start) the missing part is silence, so the end fades out', () => {
    // the loop's edges snap to zero crossings, so a loop "at 0" starts a few samples in: the song there is all there is
    const at0 = loop(0, 2.5);
    const l0 = loopFileLayout(buf, at0);
    expect(l0.start).toBeLessThan(Math.round(0.002 * SR) + 1);
    const file = new LoopFileRenderer(buf, loopFilePlan(at0, 2), { crossfadeMs: 40, adaptiveCrossfade: false, loopReady: true });
    const out = file.render(0, file.total);
    for (const c of out) for (const v of c) expect(Number.isFinite(v)).toBe(true);
    const w = file.wrapFrames;
    const src = buf.getChannelData(0);
    const body = new LoopFileRenderer(buf, loopFilePlan(at0, 2), { crossfadeMs: 40, loopReady: false }).render(0, file.total)[0]!;
    const missing = w - l0.start; // window samples that fall before the start of the song
    expect(missing).toBeGreaterThan(w - 50);
    for (const k of [0, 100, Math.floor(missing / 2), missing - 1]) {
      const theta = ((k + 0.5) / w) * (Math.PI / 2);
      // there is nothing to fade to, so the file's own end just fades out: cos(theta) x what it was
      expect(out[0]![file.total - w + k]).toBeCloseTo(Math.cos(theta) * body[file.total - w + k]!, 6);
    }
    // and it ends on the song's first samples, then the loop starts on its next
    expect(Math.abs(out[0]![file.total - 1]! - src[l0.start - 1]!)).toBeLessThan(0.002);
    // a loop that starts 5 ms into the song has 5 ms of it before the loop, then silence
    const near = loop(0.005, 2.5);
    const f2 = new LoopFileRenderer(buf, loopFilePlan(near, 1), { crossfadeMs: 40, adaptiveCrossfade: false, loopReady: true });
    const l = loopFileLayout(buf, near);
    const o2 = f2.render(0, f2.total)[0]!;
    const w2 = f2.wrapFrames;
    const at = (i: number): number => (i < 0 ? 0 : src[i]!);
    for (const k of [0, 10, w2 - 30, w2 - 1]) {
      const theta = ((k + 0.5) / w2) * (Math.PI / 2);
      expect(o2[f2.total - w2 + k]).toBeCloseTo(Math.cos(theta) * src[l.end - w2 + k]! + Math.sin(theta) * at(l.start - w2 + k), 6);
    }
  });

  it('is shorter than W when the loop is: the crossfade never reaches past the file', () => {
    const tiny = loop(3, 3.1);
    const file = new LoopFileRenderer(buf, loopFilePlan(tiny, 1), { crossfadeMs: 80, loopReady: true });
    expect(file.wrapFrames).toBeLessThanOrEqual(file.total);
    const out = file.render(0, file.total);
    for (const c of out) for (const v of c) expect(Number.isFinite(v)).toBe(true);
  });

  it('works with a smoothed seam: the file holds the rotated span and wraps at its end', () => {
    const seam = smoothSeam(3.123, 6.789, 0.11, 0.006, 60);
    const region2 = loop(3.123, 6.789, { seam });
    const l = loopFileLayout(buf, region2);
    // the rotated span: 0.11 s later than the loop the user set
    expect(Math.abs(l.start - Math.round(3.233 * SR))).toBeLessThanOrEqual(Math.round(0.002 * SR));
    const file = new LoopFileRenderer(buf, loopFilePlan(region2, 3), { crossfadeMs: 20, loopReady: true });
    const out = file.render(0, file.total)[0]!;
    const natural = maxStep(buf.getChannelData(0));
    const joined = new Float32Array(out.length * 2);
    joined.set(out, 0);
    joined.set(out, out.length);
    expect(Math.abs(joined[out.length]! - joined[out.length - 1]!)).toBeLessThan(natural * 1.05);
  });
});

describe('exporting a loop file piece by piece', () => {
  const buf = song(10);
  const region = loop(2.5, 5.2);

  async function run(job: ExportJob, extra: Partial<ExportHooks> = {}): Promise<{ bytes: Uint8Array; frames: number; pieces: number[] }> {
    const parts: ArrayBuffer[] = [];
    const pieces: number[] = [];
    let header = new Uint8Array(0);
    const result = await exportWavPieces(job, {
      onHeader: (h) => (header = h),
      onChunk: (b) => {
        pieces.push(b.byteLength);
        parts.push(b);
      },
      ...extra,
    });
    return { bytes: new Uint8Array(await new Blob([header as Uint8Array<ArrayBuffer>, ...parts]).arrayBuffer()), frames: result.frames, pieces };
  }

  it('is byte for byte the loop file encoded in one go, at every bit depth, loop-ready or not', async () => {
    for (const loopReady of [true, false]) {
      for (const bitDepth of [16, 24, 32] as const) {
        const plan = loopFilePlan(region, 4);
        const whole = new LoopFileRenderer(buf, plan, { crossfadeMs: 20, loopReady });
        const expected = await encodeWavBytes(whole.render(0, whole.total), SR, { bitDepth });
        const got = await run({ buffer: buf, plan, crossfadeMs: 20, bitDepth, stretch: null, chunkSeconds: 1.5, loopFile: { loopReady } });
        expect(got.frames).toBe(whole.total);
        expect(got.bytes.length).toBe(expected.length);
        expect(Buffer.from(got.bytes).equals(Buffer.from(expected))).toBe(true);
        expect(got.pieces.length).toBeGreaterThan(3);
      }
    }
  });

  it('writes the header from the loop file\'s own length (not the song\'s)', async () => {
    const plan = loopFilePlan(region, 3);
    const l = loopFileLayout(buf, region);
    const got = await run({ buffer: buf, plan, crossfadeMs: 20, bitDepth: 16, stretch: null, loopFile: { loopReady: true } });
    expect(got.frames).toBe(l.frames(3));
    const v = new DataView(got.bytes.buffer, got.bytes.byteOffset, 44);
    expect(v.getUint32(40, true)).toBe(l.frames(3) * 2 * 2);
    expect(got.bytes.length).toBe(44 + l.frames(3) * 2 * 2);
  });

  it('refuses a loop file that would not fit in a WAV, before writing anything, like the extended song', async () => {
    const small = makeBuffer([new Float32Array(120_000), new Float32Array(120_000)], 44100);
    const huge = loopFilePlan({ id: 'a', start: 0, end: 120_000 / 44100, repeats: 1, color: '#000' }, MAX_REPEATS);
    let touched = false;
    const hooks = { onHeader: () => (touched = true), onChunk: () => (touched = true) };
    await expect(exportWavPieces({ buffer: small, plan: huge, crossfadeMs: 0, bitDepth: 16, stretch: null, loopFile: { loopReady: true } }, hooks)).rejects.toThrow(
      /^Too long for a WAV at 16-bit \(max 6:45:47\)\. Lower the repeats\.$/,
    );
    expect(touched).toBe(false);
  });

  it('can be cancelled between pieces', async () => {
    let calls = 0;
    await expect(
      run({ buffer: buf, plan: loopFilePlan(region, 6), crossfadeMs: 20, bitDepth: 16, stretch: null, chunkSeconds: 1, loopFile: { loopReady: true } }, { cancelled: () => ++calls > 3 }),
    ).rejects.toBeInstanceOf(ExportCancelled);
  });

  it('with speed and pitch baked in the file is stretched as a whole', async () => {
    const plan = loopFilePlan(region, 2);
    const got = await run({ buffer: buf, plan, crossfadeMs: 20, bitDepth: 16, stretch: { tempo: 1.25, pitchSemitones: 0 }, chunkSeconds: 2, loopFile: { loopReady: true } });
    const l = loopFileLayout(buf, region);
    expect(Math.abs(got.frames - l.frames(2) / 1.25)).toBeLessThan(2000);
  });
});

describe('file names', () => {
  it('is `<song name> - Loop <n> (<start>-<end>).wav` with the times as m.ss.mmm', () => {
    expect(loopFileName('My Song.mp3', 2, 69.6, 72)).toBe('My Song - Loop 2 (1.09.600-1.12.000).wav');
    expect(loopFileName('Demo.wav', 1, 0, 8.5)).toBe('Demo - Loop 1 (0.00.000-0.08.500).wav');
    expect(loopFileName('Long.flac', 3, 3723.5, 3800)).toBe('Long - Loop 3 (1.02.03.500-1.03.20.000).wav');
  });

  it('has no colon and no character a file system refuses, whatever the song is called', () => {
    const name = loopFileName('Mix: "Live" <v2>? | a/b\\c*.m4a', 1, 61.25, 90);
    expect(name).toBe('Mix_ _Live_ _v2__ _ a_b_c_ - Loop 1 (1.01.250-1.30.000).wav');
    const bad = (n: string): boolean => [...n].some((ch) => ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch));
    expect(bad(name)).toBe(false);
    expect(bad(loopFileName('tab\there\u0001.wav', 1, 1, 2))).toBe(false);
  });

  it('has a name for a song with none, and does not run on for a very long one', () => {
    expect(loopFileName('', 1, 1, 2)).toBe('song - Loop 1 (0.01.000-0.02.000).wav');
    expect(loopFileName('.mp3', 1, 1, 2)).toMatch(/ - Loop 1 \(/);
    const long = loopFileName(`${'x'.repeat(500)}.wav`, 12, 100, 200);
    expect(long.length).toBeLessThan(160);
    expect(long.endsWith(' - Loop 12 (1.40.000-3.20.000).wav')).toBe(true);
  });

  it('is what the dialog sanitiser would leave alone', () => {
    const name = loopFileName('A: B', 4, 1, 2);
    expect(sanitizeFilename(name)).toBe(name);
  });
});
