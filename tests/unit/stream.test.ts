import { describe, expect, it } from 'vitest';
import { ChunkStream, STREAM_GUARD_FRAMES } from '../../src/audio/stream';
import type { ChunkSource } from '../../src/audio/stream';

// SPEC-v1.2.md 2.3: consecutive chunks scheduled back to back at exact times. The scheduler is checked here with a
// recording context; the e2e suite runs the same class on a real OfflineAudioContext and compares the samples.

interface Rec {
  buffer: { length: number; sampleRate: number; data: Float32Array[] };
  rate: number;
  when: number;
  offset: number;
  /** The time given to `stop` when it was scheduled. */
  stopAt: number | undefined;
  stopped: boolean;
  fireEnded(): void;
}

class FakeContext {
  currentTime = 0;
  sources: Rec[] = [];
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data: Float32Array[] = [];
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      data,
      copyToChannel(arr: Float32Array, i: number) {
        data[i] = arr;
      },
    };
  }
  createBufferSource() {
    const sources = this.sources;
    const rec: Partial<Rec> = { stopped: false, rate: 1 };
    const node = {
      buffer: null as Rec['buffer'] | null,
      playbackRate: { value: 1 },
      onended: null as (() => void) | null,
      connect() {},
      disconnect() {},
      start(when: number, offset = 0) {
        rec.buffer = node.buffer!;
        rec.when = when;
        rec.offset = offset;
        rec.rate = node.playbackRate.value;
        rec.fireEnded = () => node.onended?.();
        sources.push(rec as Rec);
      },
      stop(at?: number) {
        // a scheduled stop (the end of a chunk) or a real one (the stream was stopped)
        if (at !== undefined) rec.stopAt = at;
        else rec.stopped = true;
      },
    };
    return node;
  }
}

/** A source whose sample at frame f is f (so every frame can be told apart), delivered after a random delay. */
function makeSource(seconds: number, sampleRate: number, delays = true): ChunkSource & { calls: [number, number][] } {
  const totalFrames = Math.round(seconds * sampleRate);
  const calls: [number, number][] = [];
  let seed = 7;
  return {
    sampleRate,
    channels: 2,
    totalFrames,
    calls,
    async fetch(start, frames) {
      calls.push([start, frames]);
      if (delays) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        await new Promise((r) => setTimeout(r, seed % 4));
      }
      const l = Float32Array.from({ length: frames }, (_, i) => start + i);
      return [l, l.map((v) => -v)];
    },
  };
}

const ctxOf = (ctx: FakeContext) => ctx as unknown as BaseAudioContext;
const node = {} as AudioNode;

describe('ChunkStream schedules chunks back to back', () => {
  it('each chunk starts at the instant the last one ends, covering every frame once, at any sample rate', async () => {
    for (const sr of [44100, 48000, 22050, 32000, 8000]) {
      const ctx = new FakeContext();
      const source = makeSource(23.4, sr);
      const stream = new ChunkStream(ctxOf(ctx), node, source);
      expect(stream.chunkFrames).toBe(5 * sr);
      await stream.start(0, 1, 0.5);
      await stream.fill(1000);
      const s = ctx.sources;
      expect(s.length).toBe(5); // 5 + 5 + 5 + 5 + 3.4 s
      expect(s[0]!.when).toBe(0.5);
      let frame = 0;
      for (let k = 0; k < s.length; k++) {
        // what plays is the chunk's own frames, from its start to the instant the next one starts
        const len = Math.round((s[k]!.stopAt! - s[k]!.when) * sr);
        expect(s[k]!.buffer.data[0]![0]).toBe(frame);
        if (k > 0) expect(s[k]!.when).toBe(s[k - 1]!.stopAt);
        expect(s[k]!.offset).toBe(0);
        // the buffer carries a few frames of the next chunk beyond that, so a resampler never reads past the end
        const guard = s[k]!.buffer.length - len;
        expect(guard).toBe(k < s.length - 1 ? STREAM_GUARD_FRAMES : 0);
        if (guard > 0) expect(s[k]!.buffer.data[0]![len]).toBe(frame + len);
        frame += len;
      }
      expect(frame).toBe(source.totalFrames);
      // at rate 1, the whole chunks are whole numbers of seconds long: no fraction of a sample at any join
      for (const rec of s.slice(0, -1)) expect(rec.stopAt! - rec.when).toBe(5);
    }
  });

  it('plays from the middle of a chunk at the right offset, then on with whole chunks', async () => {
    const ctx = new FakeContext();
    const source = makeSource(30, 44100);
    const stream = new ChunkStream(ctxOf(ctx), node, source);
    const frame = Math.round(12.3 * 44100);
    await stream.start(frame, 1, 2);
    await stream.fill(100);
    const s = ctx.sources;
    // the chunk holding 12.3 s is chunk 2 (10 s to 15 s): it starts 2.3 s in
    expect(source.calls[0]).toEqual([10 * 44100, 5 * 44100 + STREAM_GUARD_FRAMES]);
    expect(s[0]!.offset).toBeCloseTo(2.3, 9);
    expect(s[0]!.when).toBe(2);
    // the rest of that chunk is 2.7 s, then the next chunk follows at exactly that time
    expect(s[0]!.stopAt).toBe(2 + (5 * 44100 - (frame - 10 * 44100)) / 44100);
    expect(s[1]!.when).toBe(2 + (5 * 44100 - (frame - 10 * 44100)) / 44100);
    expect(s[1]!.buffer.data[0]![0]).toBe(15 * 44100);
    expect(s.length).toBe(1 + 3);
  });

  it('a different rate changes the time each chunk takes, not the order', async () => {
    const ctx = new FakeContext();
    const stream = new ChunkStream(ctxOf(ctx), node, makeSource(20, 44100));
    await stream.start(0, 1.25, 0);
    await stream.fill(100);
    for (const rec of ctx.sources) expect(rec.rate).toBe(1.25);
    for (let k = 1; k < ctx.sources.length; k++) {
      expect(ctx.sources[k]!.when).toBe(ctx.sources[k - 1]!.stopAt);
      expect(ctx.sources[k]!.when).toBe(ctx.sources[k - 1]!.when + ctx.sources[k - 1]!.buffer.length / (44100 * 1.25) - STREAM_GUARD_FRAMES / (44100 * 1.25));
    }
    // 20 s of song at 1.25x takes 16 s
    const last = ctx.sources[ctx.sources.length - 1]!;
    expect(last.stopAt).toBeCloseTo(16, 9);
  });

  it('keeps about three chunks scheduled ahead and tops the queue up as they finish', async () => {
    const ctx = new FakeContext();
    const source = makeSource(60, 44100, false);
    const stream = new ChunkStream(ctxOf(ctx), node, source, { aheadChunks: 3 });
    await stream.start(0, 1);
    // the first chunk is scheduled when start() resolves; the others follow in the background
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.sources.length).toBe(3);
    expect(stream.queued).toBe(3);
    expect(ctx.sources.every((r) => !r.stopped)).toBe(true);
    ctx.currentTime = 5.1;
    ctx.sources[0]!.fireEnded(); // the first chunk has played
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.sources.length).toBe(4);
    expect(stream.queued).toBe(3);
    stream.stop();
  });

  it('reports the position from the clock: inside a chunk, at a join, before the start, and in a gap', async () => {
    const ctx = new FakeContext();
    const stream = new ChunkStream(ctxOf(ctx), node, makeSource(30, 44100, false), { aheadChunks: 3 });
    await stream.start(0, 1, 1);
    await new Promise((r) => setTimeout(r, 20));
    const sr = 44100;
    ctx.currentTime = 0.4;
    expect(stream.position()).toBe(0); // not started yet: where it will start
    ctx.currentTime = 3.5;
    expect(stream.position()).toBeCloseTo(2.5 * sr, 3);
    ctx.currentTime = 6; // the join of chunks 0 and 1
    expect(stream.position()).toBeCloseTo(5 * sr, 3);
    ctx.currentTime = 11.9;
    expect(stream.position()).toBeCloseTo(10.9 * sr, 3);
    stream.stop();
    expect(ctx.sources.every((r) => r.stopped)).toBe(true);
  });

  it('with a rate of 1.5 the position moves 1.5 song seconds per second', async () => {
    const ctx = new FakeContext();
    const stream = new ChunkStream(ctxOf(ctx), node, makeSource(30, 44100, false));
    await stream.start(10 * 44100, 1.5, 0);
    ctx.currentTime = 2;
    await new Promise((r) => setTimeout(r, 10));
    expect(stream.position()).toBeCloseTo(10 * 44100 + 3 * 44100, 3);
    stream.stop();
  });

  it('a late render is not played in the past: the next chunk starts a moment from now, and the position waits for it', async () => {
    const ctx = new FakeContext();
    const stream = new ChunkStream(ctxOf(ctx), node, makeSource(20, 44100, false), { aheadChunks: 1 });
    await stream.start(0, 1, 0.1);
    ctx.currentTime = 0.2;
    await new Promise((r) => setTimeout(r, 10));
    // pretend the machine stalled for 9 s
    ctx.currentTime = 9.0;
    ctx.sources[0]!.fireEnded();
    await new Promise((r) => setTimeout(r, 20));
    const late = ctx.sources[1]!;
    expect(late.when).toBeGreaterThanOrEqual(9.0);
    expect(late.when).toBeLessThan(9.2);
    expect(late.buffer.data[0]![0]).toBe(5 * 44100);
    ctx.currentTime = 8.99; // before it
    expect(stream.position()).toBe(5 * 44100);
    stream.stop();
  });

  it('says when the last frame has played, once, and not after stop', async () => {
    const ctx = new FakeContext();
    const stream = new ChunkStream(ctxOf(ctx), node, makeSource(7, 8000, false));
    let ended = 0;
    stream.onEnded = () => ended++;
    await stream.start(0, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.sources.length).toBe(2);
    ctx.sources[0]!.fireEnded();
    expect(ended).toBe(0);
    ctx.sources[1]!.fireEnded();
    expect(ended).toBe(1);
    expect(stream.position()).toBe(7 * 8000);

    const again = new ChunkStream(ctxOf(ctx), node, makeSource(7, 8000, false));
    let more = 0;
    again.onEnded = () => more++;
    await again.start(0, 1);
    again.stop();
    for (const rec of ctx.sources.slice(2)) rec.fireEnded();
    expect(more).toBe(0);
  });

  it('starting at or past the end ends at once; a new start replaces the old queue', async () => {
    const ctx = new FakeContext();
    const stream = new ChunkStream(ctxOf(ctx), node, makeSource(10, 8000, false));
    let ended = 0;
    stream.onEnded = () => ended++;
    await stream.start(10 * 8000, 1);
    expect(ended).toBe(1);
    expect(ctx.sources.length).toBe(0);
    await stream.start(0, 1);
    await new Promise((r) => setTimeout(r, 10));
    const count = ctx.sources.length;
    await stream.start(6 * 8000, 1); // a seek
    expect(ctx.sources.slice(0, count).every((r) => r.stopped)).toBe(true);
    expect(ctx.sources[count]!.buffer.data[0]![0]).toBe(5 * 8000);
    expect(ctx.sources[count]!.offset).toBe(1);
    stream.stop();
  });
});
