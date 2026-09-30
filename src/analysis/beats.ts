import { ANALYSIS_CONFIG } from './config';

type BeatConfig = typeof ANALYSIS_CONFIG.beats;

function gaussianSmooth(onset: Float32Array, period: number): Float32Array {
  const p = Math.max(1, Math.round(period));
  const win = new Float32Array(2 * p + 1);
  for (let i = -p; i <= p; i++) win[i + p] = Math.exp(-0.5 * ((i * 32) / p) ** 2);
  const n = onset.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -p; j <= p; j++) {
      const k = i + j;
      if (k >= 0 && k < n) s += onset[k]! * win[j + p]!;
    }
    out[i] = s;
  }
  return out;
}

/**
 * Ellis (2007) dynamic-programming beat tracker, as in librosa.beat.beat_track. Returns beat
 * positions as frame indices of the onset envelope.
 */
export function trackBeatFrames(
  onset: Float32Array,
  frameRate: number,
  bpm: number,
  cfg: Pick<BeatConfig, 'tightness' | 'trim'> = ANALYSIS_CONFIG.beats,
): number[] {
  const n = onset.length;
  if (n === 0 || !(bpm > 0)) return [];
  const period = (60 * frameRate) / bpm;
  const local = gaussianSmooth(onset, period);
  let localMax = 0;
  for (let i = 0; i < n; i++) localMax = Math.max(localMax, local[i]!);
  if (localMax <= 0) return [];

  const backlink = new Int32Array(n);
  const cumscore = new Float64Array(n);
  const lo = -Math.round(2 * period);
  const hi = -Math.round(period / 2);
  const span = hi - lo + 1;
  const txwt = new Float64Array(span);
  for (let j = 0; j < span; j++) {
    const off = lo + j; // negative offset (frames back)
    txwt[j] = -cfg.tightness * Math.log(-off / period) ** 2;
  }

  let firstBeat = true;
  for (let i = 0; i < n; i++) {
    let bestScore = -Infinity;
    let bestJ = 0;
    for (let j = 0; j < span; j++) {
      const idx = i + lo + j;
      const s = txwt[j]! + (idx >= 0 ? cumscore[idx]! : 0);
      if (s > bestScore) {
        bestScore = s;
        bestJ = j;
      }
    }
    cumscore[i] = local[i]! + bestScore;
    if (firstBeat && local[i]! < 0.01 * localMax) {
      backlink[i] = -1;
    } else {
      backlink[i] = i + lo + bestJ;
      firstBeat = false;
    }
  }

  // Last beat: the last local maximum of the cumulative score above half the median of the maxima.
  const maxima: number[] = [];
  for (let i = 0; i < n; i++) {
    const left = i === 0 ? -Infinity : cumscore[i - 1]!;
    const right = i === n - 1 ? -Infinity : cumscore[i + 1]!;
    if (cumscore[i]! > left && cumscore[i]! >= right) maxima.push(i);
  }
  if (maxima.length === 0) return [];
  const sorted = maxima.map((i) => cumscore[i]!).sort((a, b) => a - b);
  const median =
    sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  let last = maxima[0]!;
  for (const i of maxima) if (cumscore[i]! * 2 > median) last = i;

  const beats: number[] = [last];
  while (backlink[beats[beats.length - 1]!]! >= 0) {
    const prev = backlink[beats[beats.length - 1]!]!;
    if (prev >= beats[beats.length - 1]!) break;
    beats.push(prev);
  }
  beats.reverse();

  if (cfg.trim && beats.length > 2) {
    // Drop weak beats at both ends using a Hann-smoothed onset at the beats.
    const w = [0, 1, 2, 3, 4].map((i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4));
    const vals = beats.map((b) => local[b]!);
    const smooth = vals.map((_, i) => {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const idx = i + k;
        if (idx >= 0 && idx < vals.length) s += vals[idx]! * w[k + 2]!;
      }
      return s;
    });
    let ms = 0;
    for (const v of smooth) ms += v * v;
    const threshold = 0.5 * Math.sqrt(ms / smooth.length);
    let first = -1;
    let lastValid = -1;
    smooth.forEach((v, i) => {
      if (v > threshold) {
        if (first < 0) first = i;
        lastValid = i;
      }
    });
    if (first >= 0) return beats.slice(first, lastValid + 1);
  }
  return beats;
}

/**
 * Broadband onset strength can make the tracker lock onto off-beat hi-hats. Kicks land on the beat, so
 * compare low-frequency flux at the tracked beats with the flux half a beat later; if the half-beat
 * positions are clearly stronger, return beat times moved there. Otherwise the beats are returned as is.
 */
export function correctBeatPhase(
  beatTimes: number[],
  lfFlux: Float32Array,
  frameRate: number,
  ratio: number = ANALYSIS_CONFIG.beats.lfPhaseRatio,
): { times: number[]; shifted: boolean } {
  if (beatTimes.length < 8) return { times: beatTimes, shifted: false };
  // The coarse flux peak precedes the attack by up to ~2 frames, so look a little before each time.
  const at = (t: number): number => {
    const f = Math.round(t * frameRate);
    let m = 0;
    for (let k = -3; k <= 1; k++) {
      const v = lfFlux[f + k];
      if (v !== undefined && v > m) m = v;
    }
    return m;
  };
  let onBeat = 0;
  let offBeat = 0;
  const mids: number[] = [];
  for (let i = 0; i + 1 < beatTimes.length; i++) {
    const mid = (beatTimes[i]! + beatTimes[i + 1]!) / 2;
    mids.push(mid);
    onBeat += at(beatTimes[i]!);
    offBeat += at(mid);
  }
  if (offBeat > ratio * onBeat) {
    return { times: mids, shifted: true };
  }
  return { times: beatTimes, shifted: false };
}

/** Streaming spectral flux on a fine time grid (for refining beat positions). */
export interface FineOnset {
  /** Flux per fine frame. */
  flux: Float32Array;
  /** Seconds per fine frame. */
  dt: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Move each coarse beat (23 ms frames, whose onset peak precedes the real attack) onto the nearest
 * strong attack of a fine-resolution onset curve. Offsets that disagree with their neighbours by more
 * than 25 ms are replaced by the neighbourhood median so that one stray hi-hat cannot pull a beat away.
 */
export function refineBeatTimes(
  coarseTimes: number[],
  fine: FineOnset,
  cfg: Pick<BeatConfig, 'refineBefore' | 'refineAfter' | 'fineLatency'> = ANALYSIS_CONFIG.beats,
): number[] {
  const { flux, dt } = fine;
  const raw = coarseTimes.map((t) => {
    const a = Math.max(0, Math.floor((t - cfg.refineBefore) / dt));
    const b = Math.min(flux.length - 1, Math.ceil((t + cfg.refineAfter) / dt));
    let best = -1;
    let bestV = 0;
    for (let i = a; i <= b; i++) {
      if (flux[i]! > bestV) {
        bestV = flux[i]!;
        best = i;
      }
    }
    if (best < 0) return null;
    // Parabolic interpolation of the peak position.
    let pos = best;
    if (best > 0 && best < flux.length - 1) {
      const y0 = flux[best - 1]!;
      const y1 = flux[best]!;
      const y2 = flux[best + 1]!;
      const d = y0 - 2 * y1 + y2;
      if (d < 0) pos += (0.5 * (y0 - y2)) / d;
    }
    return pos * dt - cfg.fineLatency;
  });
  const offsets = raw.map((r, i) => (r === null ? null : r - coarseTimes[i]!));
  return coarseTimes.map((t, i) => {
    const neighbours: number[] = [];
    for (let k = -4; k <= 4; k++) {
      const o = offsets[i + k];
      if (o !== null && o !== undefined) neighbours.push(o);
    }
    if (neighbours.length === 0) return t;
    const med = median(neighbours);
    const o = offsets[i];
    if (o === null || o === undefined || Math.abs(o - med) > 0.025) return t + med;
    return t + o;
  });
}

/**
 * Fill in beats missing at the very start of the song (see beats.prependMaxBeats). Returns the times
 * unchanged unless the first beat sits about k whole periods after time zero.
 */
export function prependStartBeats(
  beatTimes: number[],
  cfg: Pick<BeatConfig, 'prependMaxBeats' | 'prependToleranceSeconds'> = ANALYSIS_CONFIG.beats,
): number[] {
  if (beatTimes.length < 4) return beatTimes;
  const d: number[] = [];
  for (let i = 1; i < Math.min(beatTimes.length, 17); i++) d.push(beatTimes[i]! - beatTimes[i - 1]!);
  const period = median(d);
  const first = beatTimes[0]!;
  if (!(period > 0)) return beatTimes;
  const k = Math.round(first / period);
  if (k < 1 || k > cfg.prependMaxBeats) return beatTimes;
  if (Math.abs(first - k * period) > cfg.prependToleranceSeconds) return beatTimes;
  const added: number[] = [];
  for (let j = k; j >= 1; j--) added.push(Math.max(0, first - j * period));
  return [...added, ...beatTimes];
}

/** Tempo implied by beat times: 60 / median inter-beat interval. */
export function tempoFromBeats(beatTimes: number[]): number | null {
  if (beatTimes.length < 3) return null;
  const d: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) d.push(beatTimes[i]! - beatTimes[i - 1]!);
  const m = median(d);
  return m > 0 ? 60 / m : null;
}
