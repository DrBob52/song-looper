import type { AudioBufferLike } from './types';
import { sniffSampleRate } from './sniff';

export const ANALYSIS_SAMPLE_RATE = 22050;

export interface DecodedSong {
  name: string;
  buffer: AudioBuffer;
  sampleRate: number;
  channels: number;
  duration: number;
}

const MIN_RATE = 8000;
const MAX_RATE = 96000;

/**
 * Decode a user-supplied file at its native sample rate (when the container
 * header can be sniffed; otherwise 44.1 kHz).
 */
export async function decodeFile(file: File): Promise<DecodedSong> {
  const data = await file.arrayBuffer();
  const sniffed = sniffSampleRate(new Uint8Array(data));
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, sniffed ?? 44100));
  // A one-frame OfflineAudioContext decodes at `rate` and needs no user gesture.
  const ctx = new OfflineAudioContext(1, 1, rate);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(data);
  } catch {
    throw new Error(
      'This file could not be decoded. Try an mp3, wav, m4a/aac, flac or ogg file that your browser can play.',
    );
  }
  return {
    name: file.name,
    buffer,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    duration: buffer.duration,
  };
}

/** Downmix to mono and resample to 22.05 kHz for analysis. */
export async function toMonoAnalysisRate(buffer: AudioBufferLike): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil(buffer.duration * ANALYSIS_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(1, frames, ANALYSIS_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer as AudioBuffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Max-abs peaks across channels, `perSecond` peaks per second, for the waveform. */
export function computePeaks(buffer: AudioBufferLike, perSecond = 100): Float32Array {
  const n = Math.max(1, Math.round(buffer.duration * perSecond));
  const peaks = new Float32Array(n);
  const step = buffer.length / n;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const from = Math.floor(i * step);
      const to = Math.max(from + 1, Math.min(buffer.length, Math.floor((i + 1) * step)));
      let m = peaks[i]!;
      for (let j = from; j < to; j++) {
        const v = Math.abs(data[j]!);
        if (v > m) m = v;
      }
      peaks[i] = m;
    }
  }
  return peaks;
}
