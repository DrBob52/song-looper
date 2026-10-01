import { SoundTouch } from '@soundtouchjs/core';
import type { StretchParams } from './renderProtocol';

/**
 * SoundTouch is fed in blocks of this many frames. Its rate transposer works block by block, so the output depends a
 * little on how the input is cut: pieces pushed to `StreamingStretcher` that are whole multiples of this make exactly
 * the output of one pass over the whole song.
 */
export const STRETCH_BLOCK = 8192;
const CHUNK = STRETCH_BLOCK;

export const MIN_TEMPO = 0.25;
export const MAX_TEMPO = 4;

/** True when neither speed nor pitch differs from the original. */
export function isNeutral(p: StretchParams | null | undefined): boolean {
  return !p || (Math.abs(p.tempo - 1) < 1e-6 && Math.abs(p.pitchSemitones) < 1e-6);
}

/** Length of the output for a given input length: the song plays `tempo` times faster. */
export function stretchedLength(frames: number, tempo: number): number {
  return Math.max(1, Math.round(frames / tempo));
}

/** A first-in first-out queue of audio: blocks go in, any number of frames come out. */
class FrameQueue {
  private blocks: Float32Array[][] = [];
  private head = 0;
  frames = 0;

  constructor(private channelCount: number) {}

  push(block: Float32Array[]): void {
    this.blocks.push(block);
    this.frames += block[0]!.length;
  }

  take(n: number): Float32Array[] {
    const out = Array.from({ length: this.channelCount }, () => new Float32Array(n));
    let filled = 0;
    while (filled < n) {
      const block = this.blocks[0]!;
      const avail = block[0]!.length - this.head;
      const take = Math.min(avail, n - filled);
      for (let c = 0; c < this.channelCount; c++) out[c]!.set(block[c]!.subarray(this.head, this.head + take), filled);
      filled += take;
      this.head += take;
      if (this.head >= block[0]!.length) {
        this.blocks.shift();
        this.head = 0;
      }
    }
    this.frames -= n;
    return out;
  }
}

/**
 * SoundTouch as a stream: feed it the song a piece at a time and it hands back what is ready, with the stretcher's
 * state kept from piece to piece, so a multi-hour song never has to be in memory. SoundTouch v2 exposes pitch only:
 * it time-stretches by 1 / pitch and then transposes the rate by pitch. To add a tempo on top, the stretch stage is
 * given tempo / pitch, so the rate transposer supplies the pitch change (factor P) and the overall speed is
 * (tempo / P) * P = tempo. Channels are processed as stereo pairs (a mono file as dual mono, files with more than two
 * channels pair by pair).
 *
 * The output is exactly `stretchedLength(totalInputFrames, tempo)` frames: `push` never hands out more, and `finish`
 * flushes the tail with silence until the rest has been produced (zeros if SoundTouch runs dry).
 */
export class StreamingStretcher {
  /** Frames the whole output will have. */
  readonly outputFrames: number;
  private engines: SoundTouch[] = [];
  private queues: FrameQueue[] = [];
  private pairs: number;
  private emitted = 0;
  private tempo: number;

  constructor(
    sampleRate: number,
    private channelCount: number,
    params: StretchParams,
    totalInputFrames: number,
  ) {
    this.tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, params.tempo));
    const pitchFactor = Math.pow(2, params.pitchSemitones / 12);
    this.pairs = Math.ceil(channelCount / 2);
    this.outputFrames = stretchedLength(totalInputFrames, this.tempo);
    for (let p = 0; p < this.pairs; p++) {
      const st = new SoundTouch({ sampleRate });
      st.pitch = pitchFactor;
      st.stretch.tempo = this.tempo / pitchFactor;
      this.engines.push(st);
      this.queues.push(new FrameQueue(2));
    }
  }

  private feed(p: number, left: Float32Array, right: Float32Array, from: number, frames: number, silence: boolean): void {
    const st = this.engines[p]!;
    const inBuf = new Float32Array(frames * 2);
    if (!silence) {
      for (let i = 0; i < frames; i++) {
        inBuf[2 * i] = left[from + i]!;
        inBuf[2 * i + 1] = right[from + i]!;
      }
    }
    st.inputBuffer.putSamples(inBuf, 0, frames);
    st.process();
    const tmp = new Float32Array(CHUNK * 2);
    for (;;) {
      const avail = st.outputBuffer.frameCount;
      if (avail <= 0) break;
      const take = Math.min(avail, CHUNK);
      st.outputBuffer.extract(tmp, 0, take);
      st.outputBuffer.receive(take);
      const l = new Float32Array(take);
      const r = new Float32Array(take);
      for (let i = 0; i < take; i++) {
        l[i] = tmp[2 * i]!;
        r[i] = tmp[2 * i + 1]!;
      }
      this.queues[p]!.push([l, r]);
    }
  }

  /** What every pair has ready (capped at what is still owed), as one array per channel. */
  private drain(limit: number): Float32Array[] {
    const ready = Math.min(limit, this.outputFrames - this.emitted, ...this.queues.map((q) => q.frames));
    const out: Float32Array[] = [];
    for (let p = 0; p < this.pairs; p++) {
      const [l, r] = this.queues[p]!.take(ready) as [Float32Array, Float32Array];
      out.push(l);
      if (2 * p + 1 < this.channelCount) out.push(r);
    }
    this.emitted += ready;
    return out;
  }

  /** Feed the next piece of the song (one array per channel); returns the output that is ready now (maybe none). */
  push(chunk: readonly Float32Array[]): Float32Array[] {
    const n = chunk[0]?.length ?? 0;
    for (let p = 0; p < this.pairs; p++) {
      const left = chunk[2 * p]!;
      const right = chunk[2 * p + 1] ?? left;
      for (let pos = 0; pos < n; pos += CHUNK) this.feed(p, left, right, pos, Math.min(CHUNK, n - pos), false);
    }
    return this.drain(Infinity);
  }

  /** After the last piece: flush, and return the rest of the output (exactly the frames still owed). */
  finish(): Float32Array[] {
    const owed = this.outputFrames - this.emitted;
    const empty = new Float32Array(0);
    for (let guard = 0; guard < 64 && this.queues.some((q) => q.frames < owed); guard++) {
      for (let p = 0; p < this.pairs; p++) this.feed(p, empty, empty, 0, CHUNK, true);
    }
    const out = this.drain(owed);
    const got = out[0]?.length ?? 0;
    if (got >= owed) return out;
    // SoundTouch ran dry: the missing end is silence
    return out.map((c) => {
      const padded = new Float32Array(owed);
      padded.set(c);
      return padded;
    });
  }
}

/**
 * Change speed (tempo only, pitch preserved) and pitch (semitones, tempo preserved) of rendered channels with
 * SoundTouch. The output is `tempo` times shorter than the input. For output that does not fit in memory use
 * `StreamingStretcher`.
 */
export function stretchChannels(
  channels: Float32Array[],
  sampleRate: number,
  params: StretchParams,
  onProgress: (fraction: number) => void = () => undefined,
): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  const st = new StreamingStretcher(sampleRate, channels.length, params, n);
  const out = channels.map(() => new Float32Array(st.outputFrames));
  let written = 0;
  const put = (piece: Float32Array[]): void => {
    const len = piece[0]?.length ?? 0;
    for (let c = 0; c < out.length; c++) out[c]!.set(piece[c]!, written);
    written += len;
  };
  for (let pos = 0; pos < n; pos += CHUNK) {
    put(st.push(channels.map((c) => c.subarray(pos, Math.min(n, pos + CHUNK)))));
    onProgress(pos / n);
  }
  put(st.finish());
  onProgress(1);
  return out;
}
