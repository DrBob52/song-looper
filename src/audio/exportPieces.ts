import type { Plan } from '../model';
import { formatClockFloor } from '../util/time';
import { RENDER_CONFIG } from './config';
import { RangeRenderer } from './render';
import type { StretchParams } from './renderProtocol';
import { STRETCH_BLOCK, StreamingStretcher, isNeutral, stretchedLength } from './stretch';
import type { AudioBufferLike } from './types';
import type { BitDepth } from './wav';
import { WavChunkEncoder, maxWavFrames, wavHeader } from './wav';

export interface ExportJob {
  buffer: AudioBufferLike;
  plan: Plan;
  crossfadeMs: number;
  bitDepth: BitDepth;
  /** Speed and pitch to bake in (null or neutral: the file is the extended song as it is). */
  stretch: StretchParams | null;
  /** Seconds of the extended song rendered, encoded and handed out at a time. Default RENDER_CONFIG.exportChunkSeconds. */
  chunkSeconds?: number;
}

export interface ExportHooks {
  /** The 44-byte WAV header; comes first. */
  onHeader(bytes: Uint8Array<ArrayBuffer>): void;
  /** The next piece of the file's data (ownership passes to the callee). */
  onChunk(bytes: ArrayBuffer): void;
  /** `fraction` of the extended song has been rendered. */
  onProgress?(fraction: number, framesDone: number, framesTotal: number): void;
  /** Called between pieces; the worker uses it to give other messages a turn. */
  yieldNow?(): Promise<void>;
  /** Stops the export (by throwing) when it returns true. */
  cancelled?(): boolean;
}

export interface ExportResult {
  /** Frames in the file and bytes in the whole file. */
  frames: number;
  bytes: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelled';
  }
}

/** What a finished export will hold, worked out before any audio is rendered: the file's frames, and the largest it may have. */
export function exportFrames(totalFrames: number, stretch: StretchParams | null): number {
  return stretch && !isNeutral(stretch) ? stretchedLength(totalFrames, stretch.tempo) : totalFrames;
}

/** The message for a file that would not fit in a WAV at this depth, or null when it fits. */
export function wavTooLong(frames: number, sampleRate: number, channels: number, bitDepth: BitDepth): string | null {
  const max = maxWavFrames(channels, bitDepth);
  if (frames <= max) return null;
  return `Too long for a WAV at ${bitDepth}-bit (max ${formatClockFloor(max / sampleRate)}).${bitDepth > 16 ? ' Lower the repeats or choose 16-bit.' : ' Lower the repeats.'}`;
}

/**
 * Write the extended song as a WAV file piece by piece: render about 10 seconds of it (`RangeRenderer`), optionally
 * pass it through SoundTouch (state kept across pieces, flushed at the end), encode it and hand the bytes out. The
 * header is written up front, because the length is known from the plan. No step ever holds more than one piece, so
 * the song can be as long as a WAV file allows.
 */
export async function exportWavPieces(job: ExportJob, hooks: ExportHooks): Promise<ExportResult> {
  const { buffer, bitDepth } = job;
  const renderer = new RangeRenderer(buffer, job.plan, { crossfadeMs: job.crossfadeMs });
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const total = renderer.total;
  const bake = job.stretch !== null && !isNeutral(job.stretch);
  const frames = exportFrames(total, job.stretch);
  const tooLong = wavTooLong(frames, sampleRate, channels, bitDepth);
  if (tooLong) throw new Error(tooLong);

  hooks.onHeader(wavHeader(frames, channels, sampleRate, bitDepth) as Uint8Array<ArrayBuffer>);
  const encoder = new WavChunkEncoder(channels, bitDepth, true);
  const stretcher = bake ? new StreamingStretcher(sampleRate, channels, job.stretch!, total) : null;
  const wanted = Math.max(1, Math.round((job.chunkSeconds ?? RENDER_CONFIG.exportChunkSeconds) * sampleRate));
  // with speed or pitch baked in, pieces are whole SoundTouch blocks, so the stretch is that of one pass over the song
  const chunkFrames = bake ? Math.max(1, Math.round(wanted / STRETCH_BLOCK)) * STRETCH_BLOCK : wanted;
  let written = 0;
  const emit = (audio: Float32Array[]): void => {
    const n = audio[0]?.length ?? 0;
    if (n === 0) return;
    hooks.onChunk(encoder.encode(audio, 0, n));
    written += n;
  };

  for (let pos = 0; pos < total; pos += chunkFrames) {
    if (hooks.cancelled?.()) throw new ExportCancelled();
    const piece = renderer.render(pos, Math.min(chunkFrames, total - pos));
    emit(stretcher ? stretcher.push(piece) : piece);
    const done = Math.min(total, pos + chunkFrames);
    hooks.onProgress?.(total > 0 ? done / total : 1, done, total);
    await hooks.yieldNow?.();
  }
  if (stretcher) emit(stretcher.finish());
  if (written !== frames) throw new Error(`The export wrote ${written} frames but expected ${frames}.`);
  hooks.onProgress?.(1, total, total);
  return { frames, bytes: 44 + frames * channels * (bitDepth / 8) };
}
