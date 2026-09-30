import FFT from 'fft.js';
import { ANALYSIS_CONFIG } from './config';

export interface StftParams {
  frameSize: number;
  hop: number;
}

export const DEFAULT_STFT: StftParams = ANALYSIS_CONFIG.stft;

/** Periodic Hann window. */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Number of (centred) frames for a signal: frame i is centred on sample i * hop. */
export function frameCount(nSamples: number, hop: number): number {
  return nSamples <= 0 ? 0 : 1 + Math.floor(nSamples / hop);
}

export function binHz(bin: number, sampleRate: number, frameSize: number): number {
  return (bin * sampleRate) / frameSize;
}

/**
 * Stream a magnitude STFT: calls `fn(frameIndex, magnitudes)` for each frame. The buffer passed
 * to `fn` is reused between frames, so copy it if you need to keep it. Signals are zero-padded by
 * half a frame on both sides so that frame i is centred on sample i * hop (time i * hop / sampleRate).
 * Magnitudes are amplitude-normalised: a full-scale sine gives a peak of about 1.
 */
export function forEachFrame(
  samples: Float32Array,
  params: StftParams,
  fn: (frame: number, mags: Float32Array, windowed: Float32Array) => void,
  onProgress?: (fraction: number) => void,
): number {
  const { frameSize: n, hop } = params;
  const bins = n / 2 + 1;
  const window = hannWindow(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) windowSum += window[i]!;
  const scale = 2 / windowSum;
  const fft = new FFT(n);
  const out = fft.createComplexArray() as number[];
  const input = new Array<number>(n).fill(0);
  const windowed = new Float32Array(n);
  const mags = new Float32Array(bins);
  const frames = frameCount(samples.length, hop);
  const half = n >> 1;
  const progressEvery = Math.max(1, Math.floor(frames / 50));

  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < samples.length ? samples[idx]! * window[i]! : 0;
      windowed[i] = v;
      input[i] = v;
    }
    fft.realTransform(out, input);
    for (let k = 0; k < bins; k++) {
      const re = out[2 * k]!;
      const im = out[2 * k + 1]!;
      mags[k] = Math.sqrt(re * re + im * im) * scale;
    }
    fn(f, mags, windowed);
    if (onProgress && f % progressEvery === 0) onProgress(f / frames);
  }
  onProgress?.(1);
  return frames;
}

export interface Spectrogram {
  mags: Float32Array;
  frames: number;
  bins: number;
}

/** Whole magnitude spectrogram in memory (frames x bins, row-major). Fine for tests and short clips. */
export function stft(samples: Float32Array, params: StftParams = DEFAULT_STFT): Spectrogram {
  const bins = params.frameSize / 2 + 1;
  const frames = frameCount(samples.length, params.hop);
  const mags = new Float32Array(frames * bins);
  forEachFrame(samples, params, (f, m) => mags.set(m, f * bins));
  return { mags, frames, bins };
}
