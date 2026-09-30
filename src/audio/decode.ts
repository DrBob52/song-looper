import type { AudioBufferLike } from './types';
import { isAdts, isMp4, mp4AudioCodec, sniffSampleRate } from './sniff';

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

const UNDECODABLE =
  'This file could not be decoded. Try an mp3, wav, m4a/aac, flac or ogg file that your browser can play.';

/**
 * Decode a user-supplied file at its native sample rate (when the container
 * header can be sniffed; otherwise 44.1 kHz).
 *
 * The browser's own decoder goes first. m4a/aac files fall back to a bundled
 * decoder when it fails, because browser support for them is patchy: Chrome
 * and Firefox can't decode Apple Lossless (ALAC) at all, and some Chromium
 * and Linux Firefox builds ship without AAC.
 */
export async function decodeFile(file: File): Promise<DecodedSong> {
  const data = await file.arrayBuffer();
  const bytes = new Uint8Array(data);
  const codec = mp4AudioCodec(bytes);
  if (codec === 'enca' || codec === 'drms') {
    throw new Error(
      'This file is copy-protected (for example an Apple Music download), so no browser can decode it. Use a DRM-free copy.',
    );
  }
  const sniffed = sniffSampleRate(bytes);
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, sniffed ?? 44100));
  // A one-frame OfflineAudioContext decodes at `rate` and needs no user gesture.
  const ctx = new OfflineAudioContext(1, 1, rate);
  let buffer: AudioBuffer;
  try {
    // decodeAudioData detaches its argument; keep `data` for the fallback.
    buffer = await ctx.decodeAudioData(data.slice(0));
  } catch {
    const aacLike = isMp4(bytes) || isAdts(bytes) || /\.(m4a|m4b|mp4|aac)$/i.test(file.name);
    if (!aacLike) throw new Error(UNDECODABLE);
    buffer = await decodeAacFallback(bytes, codec);
  }
  return {
    name: file.name,
    buffer,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    duration: buffer.duration,
  };
}

/** Decode AAC or ALAC with the bundled decoder (loaded only when needed). */
async function decodeAacFallback(bytes: Uint8Array, codec: string | null): Promise<AudioBuffer> {
  let decoded: { channelData: Float32Array[]; sampleRate: number };
  try {
    const { default: decodeAac } = await import('@audio/decode-aac');
    decoded = await decodeAac(bytes);
  } catch {
    decoded = { channelData: [], sampleRate: 0 };
  }
  const length = decoded.channelData[0]?.length ?? 0;
  if (!length || !decoded.sampleRate) {
    if (codec && codec !== 'mp4a' && codec !== 'alac') {
      throw new Error(`This file's audio uses the "${codec.trim()}" codec, which this browser can't decode. Try an mp3, wav, AAC m4a or flac file.`);
    }
    throw new Error(UNDECODABLE);
  }
  const buffer = new AudioBuffer({
    length,
    numberOfChannels: decoded.channelData.length,
    sampleRate: decoded.sampleRate,
  });
  decoded.channelData.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  return buffer;
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
