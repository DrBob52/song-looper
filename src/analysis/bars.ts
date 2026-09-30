import { ANALYSIS_CONFIG } from './config';

type BarConfig = typeof ANALYSIS_CONFIG.bars;

function zscore(x: Float64Array): Float64Array {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= Math.max(1, n);
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i]! - mean) ** 2;
  const std = Math.sqrt(v / Math.max(1, n));
  const out = new Float64Array(n);
  if (std < 1e-12) return out;
  for (let i = 0; i < n; i++) out[i] = (x[i]! - mean) / std;
  return out;
}

/**
 * Per-beat downbeat evidence: z-scored onset strength at the beat plus z-scored low-frequency
 * (under ~150 Hz) energy over the beat.
 */
export function downbeatEvidence(
  beatTimes: number[],
  onset: Float32Array,
  lowEnergy: Float32Array,
  frameRate: number,
  cfg: Pick<BarConfig, 'onsetWeight' | 'lowFreqWeight'> = ANALYSIS_CONFIG.bars,
): Float64Array {
  const n = beatTimes.length;
  const onsetAt = new Float64Array(n);
  const lfAt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = Math.round(beatTimes[i]! * frameRate);
    // the coarse onset peak sits up to ~2 frames before the attack
    let o = 0;
    for (let k = -1; k <= 3; k++) {
      const idx = f + k;
      if (idx >= 0 && idx < onset.length) o = Math.max(o, onset[idx]!);
    }
    onsetAt[i] = o;
    const next = i + 1 < n ? beatTimes[i + 1]! : beatTimes[i]! + (n > 1 ? beatTimes[i]! - beatTimes[i - 1]! : 0.5);
    const f1 = Math.max(f + 1, Math.round(next * frameRate));
    let s = 0;
    let c = 0;
    for (let k = f; k < f1 && k < lowEnergy.length; k++) {
      if (k >= 0) {
        s += lowEnergy[k]!;
        c++;
      }
    }
    lfAt[i] = c ? s / c : 0;
  }
  const zo = zscore(onsetAt);
  const zl = zscore(lfAt);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = cfg.onsetWeight * zo[i]! + cfg.lowFreqWeight * zl[i]!;
  return out;
}

/** The bar phase (0..beatsPerBar-1) whose beats have the highest mean downbeat evidence. */
export function pickBarPhase(evidence: Float64Array, beatsPerBar: number): { phase: number; scores: number[] } {
  const scores: number[] = [];
  for (let p = 0; p < beatsPerBar; p++) {
    let s = 0;
    let c = 0;
    for (let i = p; i < evidence.length; i += beatsPerBar) {
      s += evidence[i]!;
      c++;
    }
    scores.push(c ? s / c : -Infinity);
  }
  let phase = 0;
  for (let p = 1; p < beatsPerBar; p++) if (scores[p]! > scores[phase]!) phase = p;
  return { phase, scores };
}

/** Beat indices that start a bar, given the phase of the first downbeat. */
export function barBeatIndices(nBeats: number, phase: number, beatsPerBar: number): number[] {
  const out: number[] = [];
  for (let i = phase; i < nBeats; i += beatsPerBar) out.push(i);
  return out;
}
