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
