import { ANALYSIS_CONFIG } from './config';

export interface TempoResult {
  bpm: number;
  /** Second-best tempo from a different peak (often half or double). */
  bpmAlt: number;
  /** Normalised autocorrelation at the chosen tempo, 0..1. Low means "no steady beat". */
  confidence: number;
}

type TempoConfig = typeof ANALYSIS_CONFIG.tempo;

/** Log-normal prior over tempo: a Gaussian in log2(bpm) around the prior BPM. */
export function tempoPrior(bpm: number, cfg: TempoConfig = ANALYSIS_CONFIG.tempo): number {
  const x = Math.log2(bpm / cfg.priorBpm) / cfg.priorSigmaOctaves;
  return Math.exp(-0.5 * x * x);
}

/** Mean autocorrelation of `onset` at a fractional lag (frames), linearly interpolated. */
export function autocorrAt(onset: Float32Array, lag: number): number {
  const n = onset.length;
  const whole = Math.floor(lag);
  const frac = lag - whole;
  const limit = n - whole - 2;
  if (limit <= 0) return 0;
  let sum = 0;
  for (let t = 0; t < limit; t++) {
    const a = onset[t]!;
    if (a === 0) continue;
    sum += a * (onset[t + whole]! * (1 - frac) + onset[t + whole + 1]! * frac);
  }
  return sum / limit;
}

/**
 * Tempo from the autocorrelation of the onset envelope over lags matching minBpm..maxBpm,
 * weighted by a log-normal prior centred on priorBpm.
 */
export function estimateTempo(
  onset: Float32Array,
  frameRate: number,
  cfg: TempoConfig = ANALYSIS_CONFIG.tempo,
): TempoResult {
  const n = onset.length;
  // Work on the mean-removed envelope: a non-negative envelope has a constant autocorrelation offset that
  // would make noise look rhythmic and let the prior dominate.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i]!;
  mean /= Math.max(1, n);
  const centered = new Float32Array(n);
  let a0 = 0;
  for (let i = 0; i < n; i++) {
    centered[i] = onset[i]! - mean;
    a0 += centered[i]! * centered[i]!;
  }
  a0 /= Math.max(1, n);
  const fallback: TempoResult = {
    bpm: cfg.priorBpm,
    bpmAlt: Math.min(cfg.maxBpm, cfg.priorBpm * 2),
    confidence: 0,
  };
  if (a0 < 1e-9 || n < frameRate * 4) return fallback;

  const steps = Math.floor((cfg.maxBpm - cfg.minBpm) / cfg.gridStepBpm) + 1;
  const bpms = new Float64Array(steps);
  const raw = new Float64Array(steps);
  const score = new Float64Array(steps);
  for (let i = 0; i < steps; i++) {
    const bpm = cfg.minBpm + i * cfg.gridStepBpm;
    bpms[i] = bpm;
    raw[i] = autocorrAt(centered, (60 * frameRate) / bpm);
    score[i] = Math.max(0, raw[i]!) * tempoPrior(bpm, cfg);
  }

  let best = 0;
  for (let i = 1; i < steps; i++) if (score[i]! > score[best]!) best = i;

  // Parabolic refinement around the peak.
  let bpm = bpms[best]!;
  if (best > 0 && best < steps - 1) {
    const y0 = score[best - 1]!;
    const y1 = score[best]!;
    const y2 = score[best + 1]!;
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) bpm += (0.5 * (y0 - y2)) / denom * cfg.gridStepBpm;
  }

  // Alternative: the best local maximum whose tempo differs clearly from the winner.
  let alt = -1;
  for (let i = 1; i < steps - 1; i++) {
    if (!(score[i]! > score[i - 1]! && score[i]! >= score[i + 1]!)) continue;
    if (Math.abs(bpms[i]! - bpm) / bpm < cfg.altMinSeparation) continue;
    if (alt < 0 || score[i]! > score[alt]!) alt = i;
  }
  let bpmAlt: number;
  if (alt >= 0) bpmAlt = bpms[alt]!;
  else bpmAlt = bpm * 2 <= cfg.maxBpm ? bpm * 2 : Math.max(cfg.minBpm, bpm / 2);

  const confidence = Math.max(0, Math.min(1, raw[best]! / a0));
  return { bpm, bpmAlt, confidence };
}
