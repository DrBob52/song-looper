import { describe, expect, it } from 'vitest';
import type { LoopRegion } from '../../src/model';
import { MAX_REPEATS } from '../../src/model';
import { ExportCancelled, exportFrames, exportWavPieces, wavTooLong } from '../../src/audio/exportPieces';
import type { ExportHooks, ExportJob } from '../../src/audio/exportPieces';
import { renderExtended } from '../../src/audio/render';
import { STRETCH_BLOCK, StreamingStretcher, stretchChannels, stretchedLength } from '../../src/audio/stretch';
import { solveRepeats } from '../../src/audio/target';
import { makeBuffer } from '../../src/audio/types';
import { encodeWavBytes, maxWavFrames } from '../../src/audio/wav';
import { formatClockFloor, parseClock } from '../../src/util/time';

function noise(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = (x / 2147483648 - 1) * 0.6;
  }
  return out;
}

const region = (id: string, start: number, end: number, repeats: number): LoopRegion => ({ id, start, end, repeats, color: '#000' });

/** Run an export, collecting header and data pieces like the main thread does. */
async function runExport(job: ExportJob, extra: Partial<ExportHooks> = {}): Promise<{ bytes: Uint8Array; pieces: number[]; header: Uint8Array; frames: number; progress: number[] }> {
  const pieces: number[] = [];
  const parts: ArrayBuffer[] = [];
  const progress: number[] = [];
  let header = new Uint8Array(0);
  const result = await exportWavPieces(job, {
    onHeader: (h) => (header = h),
    onChunk: (b) => {
      pieces.push(b.byteLength);
      parts.push(b);
    },
    onProgress: (f) => progress.push(f),
    ...extra,
  });
  const all = new Uint8Array(await new Blob([header as Uint8Array<ArrayBuffer>, ...parts]).arrayBuffer());
  return { bytes: all, pieces, header, frames: result.frames, progress };
}

describe('exportWavPieces: the same file as the whole-song path, written a piece at a time', () => {
  const sr = 8000;
  const song = makeBuffer([noise(sr * 20, 5), noise(sr * 20, 6)], sr);
  const plan = { regions: [region('a', 4, 9, 7), region('b', 12, 15.5, 3)] };

  it('is byte for byte the whole render encoded in one go, at every bit depth', async () => {
    const whole = renderExtended(song, plan, { crossfadeMs: 20 });
    for (const bitDepth of [16, 24, 32] as const) {
      const expected = await encodeWavBytes(whole, sr, { bitDepth });
      const got = await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth, stretch: null, chunkSeconds: 3 });
      expect(got.bytes.length).toBe(expected.length);
      expect(Buffer.from(got.bytes).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it('never holds more than one piece: every piece is at most chunkSeconds of audio', async () => {
    const got = await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth: 16, stretch: null, chunkSeconds: 2.5 });
    const maxBytes = Math.round(2.5 * sr) * 2 * 2;
    expect(Math.max(...got.pieces)).toBeLessThanOrEqual(maxBytes);
    expect(got.pieces.length).toBeGreaterThan(10);
    expect(got.pieces.reduce((a, b) => a + b, 0)).toBe(got.bytes.length - 44);
  });

  it('writes the header up front from the plan: data size, duration and RIFF size all agree', async () => {
    const got = await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth: 24, stretch: null, chunkSeconds: 4 });
    const v = new DataView(got.header.buffer, got.header.byteOffset, 44);
    const frames = song.length + 6 * 5 * sr + 2 * 3.5 * sr;
    expect(Math.abs(got.frames - frames)).toBeLessThan(12 * 0.002 * sr); // zero-crossing snaps move edges by a few samples
    expect(v.getUint32(40, true)).toBe(got.frames * 2 * 3);
    expect(v.getUint32(4, true)).toBe(36 + got.frames * 2 * 3);
    expect(got.bytes.length).toBe(44 + got.frames * 2 * 3);
    expect(got.progress[got.progress.length - 1]).toBe(1);
    for (let i = 1; i < got.progress.length; i++) expect(got.progress[i]!).toBeGreaterThanOrEqual(got.progress[i - 1]!);
  });

  it('with speed and pitch baked in, the length is known up front and the pieces join into the one-shot stretch', async () => {
    const stretch = { tempo: 1.25, pitchSemitones: -2.5 };
    const whole = renderExtended(song, plan, { crossfadeMs: 20 });
    const stretched = stretchChannels(whole, sr, stretch);
    const expected = await encodeWavBytes(stretched, sr, { bitDepth: 16 });
    const got = await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth: 16, stretch, chunkSeconds: 3 });
    expect(got.frames).toBe(stretchedLength(whole[0]!.length, 1.25));
    expect(got.bytes.length).toBe(expected.length);
    // identical to the one-shot stretch (SoundTouch does not depend on how the input is cut up)
    let worst = 0;
    const a = new DataView(got.bytes.buffer, got.bytes.byteOffset);
    const b = new DataView(expected.buffer, expected.byteOffset);
    for (let o = 44; o < expected.length; o += 2) worst = Math.max(worst, Math.abs(a.getInt16(o, true) - b.getInt16(o, true)));
    expect(worst).toBe(0);
  });

  it('a neutral stretch is no stretch', async () => {
    const a = await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth: 16, stretch: { tempo: 1, pitchSemitones: 0 }, chunkSeconds: 5 });
    const b = await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth: 16, stretch: null, chunkSeconds: 5 });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('stops when told to, without writing the rest', async () => {
    let calls = 0;
    const done: number[] = [];
    await expect(
      runExport(
        { buffer: song, plan, crossfadeMs: 20, bitDepth: 16, stretch: null, chunkSeconds: 1 },
        {
          cancelled: () => ++calls > 4,
          onChunk: (b) => done.push(b.byteLength),
        },
      ),
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(done.length).toBe(4);
  });

  it('gives other work a turn between pieces', async () => {
    let yields = 0;
    await runExport({ buffer: song, plan, crossfadeMs: 20, bitDepth: 16, stretch: null, chunkSeconds: 4 }, { yieldNow: async () => void yields++ });
    expect(yields).toBeGreaterThanOrEqual(5);
  });

  it('refuses a song that would not fit in a WAV, before rendering or writing anything', async () => {
    // 120,000 frames repeated 9,999 times is 1.2 billion frames: over the 16-bit stereo cap (1.07 billion)
    const small = makeBuffer([new Float32Array(120_000), new Float32Array(120_000)], 44100);
    const huge = { regions: [region('a', 0, 120_000 / 44100, MAX_REPEATS)] };
    let touched = false;
    const hooks = { onHeader: () => (touched = true), onChunk: () => (touched = true) };
    await expect(exportWavPieces({ buffer: small, plan: huge, crossfadeMs: 0, bitDepth: 16, stretch: null }, hooks)).rejects.toThrow(
      /^Too long for a WAV at 16-bit \(max 6:45:47\)\. Lower the repeats\.$/,
    );
    expect(touched).toBe(false);
    // 24- and 32-bit have less room: a plan that fits at 16-bit is refused at 32-bit
    const fits16 = { regions: [region('a', 0, 120_000 / 44100, 7000)] }; // 840 million frames
    await expect(exportWavPieces({ buffer: small, plan: fits16, crossfadeMs: 0, bitDepth: 32, stretch: null }, hooks)).rejects.toThrow(/at 32-bit \(max 3:22:53\)\. Lower the repeats or choose 16-bit\./);
    expect(touched).toBe(false);
  });
});

describe('caps, repeat limits and target length at the cap (SPEC-v1.2.md 2.1)', () => {
  it('wavTooLong says how long a file may be at each depth, and nothing for one that fits', () => {
    const sr = 44100;
    const cap16 = maxWavFrames(2, 16);
    expect(wavTooLong(cap16, sr, 2, 16)).toBeNull();
    expect(wavTooLong(cap16 + 1, sr, 2, 16)).toBe('Too long for a WAV at 16-bit (max 6:45:47). Lower the repeats.');
    expect(wavTooLong(cap16, sr, 2, 24)).toBe('Too long for a WAV at 24-bit (max 4:30:31). Lower the repeats or choose 16-bit.');
    expect(wavTooLong(cap16, sr, 2, 32)).toMatch(/^Too long for a WAV at 32-bit \(max 3:22:53\)/);
    expect(wavTooLong(maxWavFrames(2, 24), sr, 2, 24)).toBeNull();
    // mono doubles the room, a higher sample rate shortens it
    expect(wavTooLong(cap16 + 1, sr, 1, 16)).toBeNull();
    expect(wavTooLong(maxWavFrames(2, 16) + 1, 48000, 2, 16)).toMatch(/max 6:12:\d\d\)/);
  });

  it('exportFrames: the stretched length when speed is baked in, else the length itself', () => {
    expect(exportFrames(1000, null)).toBe(1000);
    expect(exportFrames(1000, { tempo: 1, pitchSemitones: 0 })).toBe(1000);
    expect(exportFrames(1000, { tempo: 2, pitchSemitones: 3 })).toBe(500);
    expect(exportFrames(1000, { tempo: 0.5, pitchSemitones: 0 })).toBe(2000);
  });

  it('repeat counts go to 9,999, and the length math holds there', () => {
    expect(MAX_REPEATS).toBe(9999);
    const sr = 44100;
    // a 5 minute song with a 10 s loop at 9,999 repeats: 27.7 hours, far over the WAV limit
    const song = 300;
    const loop = 10;
    const ext = song + (MAX_REPEATS - 1) * loop;
    expect(Math.round(ext * sr)).toBeGreaterThan(maxWavFrames(2, 16));
    expect(wavTooLong(Math.round(ext * sr), sr, 2, 16)).not.toBeNull();
    // 2,300 repeats of it is under the cap (6:45:47 = 24347 s)
    expect(wavTooLong(Math.round((song + 2300 * loop) * sr), sr, 2, 16)).toBeNull();
  });

  it('target length: a target at the cap is solved to within half a loop, and the solver stops at 9,999', () => {
    const sr = 44100;
    const cap = maxWavFrames(2, 16) / sr;
    const song = 222;
    const regions = [{ start: 30, end: 44, score: 0.9 }, { start: 100, end: 108.5, score: 0.6 }];
    const target = Math.floor(cap) - 1;
    const r = solveRepeats(regions, song, target);
    expect(Math.abs(r.error)).toBeLessThanOrEqual(8.5 / 2 + 1e-9);
    expect(r.total).toBeLessThanOrEqual(cap + 4.25);
    // typed as h:mm:ss or m:ss
    expect(parseClock(formatClockFloor(cap))).toBe(24347);
    expect(parseClock('6:45:47')).toBe(24347);
    expect(parseClock('405:47')).toBe(24347);
    // with every region at the repeat limit, an even bigger target cannot be reached and the solver says by how much
    const stuck = solveRepeats([{ start: 0, end: 10 }], song, 1_000_000);
    expect(stuck.repeats).toEqual([MAX_REPEATS]);
    expect(stuck.error).toBeLessThan(0);
  });
});

describe('StreamingStretcher', () => {
  const sr = 22050;
  const n = sr * 3 + 321;
  const l = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.31));
  const r = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i * 0.07));

  it('gives the output of one pass when the pieces are whole blocks, and always exactly the promised length', () => {
    const reference = stretchChannels([l, r], sr, { tempo: 0.8, pitchSemitones: 1.5 });
    const B = STRETCH_BLOCK;
    // pieces of whole blocks: identical to one pass; odd sizes: same length, and sound (checked below)
    for (const sizes of [[n], [B], [3 * B], [B, 2 * B, 5 * B]]) {
      const st = new StreamingStretcher(sr, 2, { tempo: 0.8, pitchSemitones: 1.5 }, n);
      const out: Float32Array[][] = [];
      for (let pos = 0, k = 0; pos < n; k++) {
        const len = Math.min(sizes[k % sizes.length]!, n - pos);
        out.push(st.push([l.subarray(pos, pos + len), r.subarray(pos, pos + len)]));
        pos += len;
      }
      out.push(st.finish());
      const joined = [0, 1].map((c) => {
        const all = new Float32Array(out.reduce((s, o) => s + o[c]!.length, 0));
        let at = 0;
        for (const o of out) {
          all.set(o[c]!, at);
          at += o[c]!.length;
        }
        return all;
      });
      expect(joined[0]!.length).toBe(stretchedLength(n, 0.8));
      expect(joined[0]!.length).toBe(st.outputFrames);
      let worst = 0;
      for (let c = 0; c < 2; c++) for (let i = 0; i < joined[c]!.length; i++) worst = Math.max(worst, Math.abs(joined[c]![i]! - reference[c]![i]!));
      expect(worst).toBe(0);
    }
    for (const sizes of [[5000], [12345, 7, 40000, 3], [441]]) {
      const st = new StreamingStretcher(sr, 2, { tempo: 0.8, pitchSemitones: 1.5 }, n);
      let frames = 0;
      let finite = true;
      for (let pos = 0, k = 0; pos < n; k++) {
        const len = Math.min(sizes[k % sizes.length]!, n - pos);
        const o = st.push([l.subarray(pos, pos + len), r.subarray(pos, pos + len)]);
        frames += o[0]!.length;
        finite &&= o[0]!.every(Number.isFinite);
        pos += len;
      }
      frames += st.finish()[0]!.length;
      expect(frames).toBe(stretchedLength(n, 0.8));
      expect(finite).toBe(true);
    }
  });
});
