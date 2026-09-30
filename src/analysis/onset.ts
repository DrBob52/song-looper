import { ANALYSIS_CONFIG } from './config';

/** log(1 + gamma * magnitude). */
export function logCompress(mag: number, gamma = ANALYSIS_CONFIG.onset.logGain): number {
  return Math.log(1 + gamma * mag);
}

/**
 * Streaming spectral flux: feed magnitude frames in order; `push` returns the sum over bins of the
 * half-wave-rectified increase of the log-compressed magnitude since the previous frame (0 for frame 0).
 */
export class FluxAccumulator {
  private prev: Float32Array | null = null;

  constructor(
    private bins: number,
    private gamma = ANALYSIS_CONFIG.onset.logGain,
  ) {}

  push(mags: Float32Array): number {
    const cur = new Float32Array(this.bins);
    let flux = 0;
    const prev = this.prev;
    for (let k = 0; k < this.bins; k++) {
      const v = Math.log(1 + this.gamma * mags[k]!);
      cur[k] = v;
      if (prev) {
        const d = v - prev[k]!;
        if (d > 0) flux += d;
      }
    }
    this.prev = cur;
    return flux;
  }
}

/** Centred moving average with shrinking windows at the edges. */
export function movingAverage(x: Float32Array, width: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const half = Math.max(1, Math.floor(width / 2));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + x[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (prefix[b]! - prefix[a]!) / (b - a);
  }
  return out;
}

/**
 * Turn raw flux into the onset strength envelope: subtract a local mean (about 0.5 s), clip at 0,
 * and normalise to unit standard deviation (the scale the Ellis tracker's tightness term expects).
 * An all-zero (silent) input stays all zero.
 */
export function normalizeOnset(
  flux: Float32Array,
  frameRate: number,
  localMeanSeconds = ANALYSIS_CONFIG.onset.localMeanSeconds,
): Float32Array {
  const mean = movingAverage(flux, Math.round(localMeanSeconds * frameRate));
  const out = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) out[i] = Math.max(0, flux[i]! - mean[i]!);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) {
    sum += out[i]!;
    sumSq += out[i]! * out[i]!;
  }
  const n = Math.max(1, out.length);
  const variance = sumSq / n - (sum / n) ** 2;
  const std = Math.sqrt(Math.max(0, variance));
  if (std < 1e-9) return new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / std;
  return out;
}

/** Convenience for tests: onset strength straight from a whole spectrogram. */
export function onsetStrength(
  mags: Float32Array,
  frames: number,
  bins: number,
  frameRate: number,
): Float32Array {
  const acc = new FluxAccumulator(bins);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) flux[f] = acc.push(mags.subarray(f * bins, (f + 1) * bins));
  return normalizeOnset(flux, frameRate);
}
