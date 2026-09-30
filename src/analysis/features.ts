import { ANALYSIS_CONFIG } from './config';
import { FluxAccumulator, normalizeOnset } from './onset';
import { forEachFrame, frameCount } from './stft';
import type { FineOnset } from './beats';

type FeatureConfig = typeof ANALYSIS_CONFIG.features;

export const CHROMA_BINS = 12;

const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number): number => 700 * (10 ** (m / 2595) - 1);

/** Pitch class (0 = C) for each FFT bin between chromaMinHz and chromaMaxHz, else -1. */
export function chromaBinMap(
  sampleRate: number,
  frameSize: number,
  cfg: Pick<FeatureConfig, 'chromaMinHz' | 'chromaMaxHz'> = ANALYSIS_CONFIG.features,
): Int8Array {
  const bins = frameSize / 2 + 1;
  const map = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = (k * sampleRate) / frameSize;
    if (f < cfg.chromaMinHz || f > cfg.chromaMaxHz) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    map[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  return map;
}

export interface MelFilter {
  start: number;
  weights: Float32Array;
}

/** Triangular mel filterbank over FFT bins. */
export function melFilterbank(
  sampleRate: number,
  frameSize: number,
  cfg: Pick<FeatureConfig, 'melBands' | 'melMinHz'> = ANALYSIS_CONFIG.features,
): MelFilter[] {
  const bins = frameSize / 2 + 1;
  const fmax = sampleRate / 2;
  const mMin = hzToMel(cfg.melMinHz);
  const mMax = hzToMel(fmax);
  const pts: number[] = [];
  for (let i = 0; i < cfg.melBands + 2; i++) pts.push(melToHz(mMin + ((mMax - mMin) * i) / (cfg.melBands + 1)));
  const filters: MelFilter[] = [];
  for (let b = 0; b < cfg.melBands; b++) {
    const lo = pts[b]!;
    const mid = pts[b + 1]!;
    const hi = pts[b + 2]!;
    const kLo = Math.max(0, Math.floor((lo * frameSize) / sampleRate));
    const kHi = Math.min(bins - 1, Math.ceil((hi * frameSize) / sampleRate));
    const w = new Float32Array(kHi - kLo + 1);
    let sum = 0;
    for (let k = kLo; k <= kHi; k++) {
      const f = (k * sampleRate) / frameSize;
      const v = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
      w[k - kLo] = Math.max(0, v);
      sum += w[k - kLo]!;
    }
    if (sum > 0) for (let i = 0; i < w.length; i++) w[i] = w[i]! / sum;
    filters.push({ start: kLo, weights: w });
  }
  return filters;
}

/** Per-frame data from one pass over the STFT. */
export interface FrameData {
  frames: number;
  frameRate: number;
  hop: number;
  sampleRate: number;
  /** Onset strength envelope (normalised). */
  onset: Float32Array;
  /** Low-frequency (< ~150 Hz) magnitude sum per frame. */
  lowEnergy: Float32Array;
  /** Spectral flux of the low-frequency bins only (kick onsets), unnormalised. */
  lfFlux: Float32Array;
  /** Mean-square level per frame (window weighted). */
  energy: Float32Array;
  /** frames x 12, unnormalised pitch-class magnitude sums. */
  chroma: Float32Array;
  /** frames x melBands, log mel power in dB (floored at -80). */
  logMel: Float32Array;
}

/** One pass over the STFT computing everything the later stages need per frame. */
export function computeFrameData(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): FrameData {
  const { frameSize, hop } = ANALYSIS_CONFIG.stft;
  const cfg = ANALYSIS_CONFIG.features;
  const bins = frameSize / 2 + 1;
  const frames = frameCount(samples.length, hop);
  const frameRate = sampleRate / hop;

  const chromaMap = chromaBinMap(sampleRate, frameSize, cfg);
  const mel = melFilterbank(sampleRate, frameSize, cfg);
  const lfBins = Math.max(1, Math.floor((ANALYSIS_CONFIG.bars.lowFreqMaxHz * frameSize) / sampleRate));

  const flux = new Float32Array(frames);
  const lowEnergy = new Float32Array(frames);
  const lfFlux = new Float32Array(frames);
  const energy = new Float32Array(frames);
  const chroma = new Float32Array(frames * CHROMA_BINS);
  const logMel = new Float32Array(frames * cfg.melBands);
  const acc = new FluxAccumulator(bins);
  const lfAcc = new FluxAccumulator(lfBins + 1);

  let windowPower = 0;
  {
    // Σ w² for normalising the time-domain frame energy
    for (let i = 0; i < frameSize; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameSize);
      windowPower += w * w;
    }
  }

  forEachFrame(
    samples,
    ANALYSIS_CONFIG.stft,
    (f, mags, windowed) => {
      flux[f] = acc.push(mags);
      let lf = 0;
      for (let k = 0; k <= lfBins; k++) lf += mags[k]!;
      lowEnergy[f] = lf;
      lfFlux[f] = lfAcc.push(mags.subarray(0, lfBins + 1));
      let e = 0;
      for (let i = 0; i < frameSize; i++) e += windowed[i]! * windowed[i]!;
      energy[f] = e / windowPower;
      const co = f * CHROMA_BINS;
      for (let k = 1; k < bins; k++) {
        const pc = chromaMap[k]!;
        if (pc >= 0) chroma[co + pc] = chroma[co + pc]! + mags[k]!;
      }
      const mo = f * cfg.melBands;
      for (let b = 0; b < mel.length; b++) {
        const { start, weights } = mel[b]!;
        let p = 0;
        for (let i = 0; i < weights.length; i++) {
          const m = mags[start + i]!;
          p += weights[i]! * m * m;
        }
        logMel[mo + b] = Math.max(-80, 10 * Math.log10(Math.max(p, 1e-8)));
      }
    },
    onProgress,
  );

  return {
    frames,
    frameRate,
    hop,
    sampleRate,
    onset: normalizeOnset(flux, frameRate),
    lowEnergy,
    lfFlux,
    energy,
    chroma,
    logMel,
  };
}

/** Fine-resolution spectral flux (short window, small hop) for beat refinement. */
export function computeFineOnset(samples: Float32Array, sampleRate: number): FineOnset {
  const { fineFrameSize, fineHop } = ANALYSIS_CONFIG.beats;
  const bins = fineFrameSize / 2 + 1;
  const frames = frameCount(samples.length, fineHop);
  const flux = new Float32Array(frames);
  const acc = new FluxAccumulator(bins);
  forEachFrame(samples, { frameSize: fineFrameSize, hop: fineHop }, (f, mags) => {
    flux[f] = acc.push(mags);
  });
  return { flux, dt: fineHop / sampleRate };
}

// ---------------------------------------------------------------------------
// Beat-synchronous features (spec 4.6)
// ---------------------------------------------------------------------------

export interface BeatFeatures {
  beats: number;
  chromaDims: number;
  timbreDims: number;
  /** beats x 12, L2-normalised mean chroma. */
  chroma: Float32Array;
  /** beats x 13, MFCC-style coefficients 1..13, z-scored over the song. */
  timbre: Float32Array;
  /** RMS level per beat in dB. */
  loudness: Float32Array;
  /** beats x (12 + 13): [chroma * wChroma, timbre * wTimbre]. */
  combined: Float32Array;
  dims: number;
}

/** DCT-II of `x`, returning coefficients 1..count (coefficient 0 is dropped). */
export function dctCoefficients(x: Float32Array | number[], count: number): Float32Array {
  const m = x.length;
  const out = new Float32Array(count);
  for (let k = 1; k <= count; k++) {
    let s = 0;
    for (let n = 0; n < m; n++) s += x[n]! * Math.cos((Math.PI * k * (n + 0.5)) / m);
    out[k - 1] = s * Math.sqrt(2 / m);
  }
  return out;
}

/**
 * Average the per-frame features over each beat interval: chroma (L2-normalised), timbre (40-band
 * log-mel -> DCT -> coefficients 1..13, z-scored per coefficient over the song) and loudness (dB).
 */
export function beatSyncFeatures(
  fd: FrameData,
  beatTimes: number[],
  cfg: FeatureConfig = ANALYSIS_CONFIG.features,
): BeatFeatures {
  const n = beatTimes.length;
  const tdims = cfg.mfccCount;
  const chroma = new Float32Array(n * CHROMA_BINS);
  const timbre = new Float32Array(n * tdims);
  const loudness = new Float32Array(n);
  const meanInterval = n > 1 ? (beatTimes[n - 1]! - beatTimes[0]!) / (n - 1) : 0.5;
  const meanMel = new Float32Array(cfg.melBands);

  for (let i = 0; i < n; i++) {
    const t0 = beatTimes[i]!;
    const t1 = i + 1 < n ? beatTimes[i + 1]! : t0 + meanInterval;
    const f0 = Math.min(fd.frames - 1, Math.max(0, Math.round(t0 * fd.frameRate)));
    const f1 = Math.min(fd.frames, Math.max(f0 + 1, Math.round(t1 * fd.frameRate)));
    const count = f1 - f0;
    const co = i * CHROMA_BINS;
    meanMel.fill(0);
    let e = 0;
    for (let f = f0; f < f1; f++) {
      for (let c = 0; c < CHROMA_BINS; c++) chroma[co + c] = chroma[co + c]! + fd.chroma[f * CHROMA_BINS + c]!;
      for (let b = 0; b < cfg.melBands; b++) meanMel[b] = meanMel[b]! + fd.logMel[f * cfg.melBands + b]!;
      e += fd.energy[f]!;
    }
    // L2-normalise chroma
    let norm = 0;
    for (let c = 0; c < CHROMA_BINS; c++) norm += chroma[co + c]! * chroma[co + c]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let c = 0; c < CHROMA_BINS; c++) chroma[co + c] = chroma[co + c]! / norm;
    for (let b = 0; b < cfg.melBands; b++) meanMel[b] = meanMel[b]! / count;
    timbre.set(dctCoefficients(meanMel, tdims), i * tdims);
    loudness[i] = 10 * Math.log10(e / count + 1e-10);
  }

  // z-score each timbre coefficient over the song
  for (let d = 0; d < tdims; d++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += timbre[i * tdims + d]!;
    mean /= Math.max(1, n);
    let v = 0;
    for (let i = 0; i < n; i++) v += (timbre[i * tdims + d]! - mean) ** 2;
    const std = Math.sqrt(v / Math.max(1, n));
    for (let i = 0; i < n; i++) timbre[i * tdims + d] = std > 1e-9 ? (timbre[i * tdims + d]! - mean) / std : 0;
  }

  const dims = CHROMA_BINS + tdims;
  const combined = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < CHROMA_BINS; c++) combined[i * dims + c] = chroma[i * CHROMA_BINS + c]! * cfg.wChroma;
    for (let d = 0; d < tdims; d++) combined[i * dims + CHROMA_BINS + d] = timbre[i * tdims + d]! * cfg.wTimbre;
  }
  return { beats: n, chromaDims: CHROMA_BINS, timbreDims: tdims, chroma, timbre, loudness, combined, dims };
}
