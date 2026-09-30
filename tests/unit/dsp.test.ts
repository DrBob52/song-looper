import { describe, expect, it } from 'vitest';
import { barBeatIndices } from '../../src/analysis/bars';
import { autocorrAt, estimateTempo, tempoPrior } from '../../src/analysis/tempo';
import { trackBeatFrames, prependStartBeats, tempoFromBeats } from '../../src/analysis/beats';
import {
  CHROMA_BINS,
  beatSyncFeatures,
  chromaBinMap,
  computeFrameData,
  dctCoefficients,
  melFilterbank,
} from '../../src/analysis/features';
import { FluxAccumulator, movingAverage, normalizeOnset, onsetStrength } from '../../src/analysis/onset';
import { clusterSegments, findSections, noveltyCurve, pickPeaks, labelName } from '../../src/analysis/sections';
import { delayEmbed, selfSimilarity } from '../../src/analysis/ssm';
import { forEachFrame, frameCount, hannWindow, stft } from '../../src/analysis/stft';
import { sine } from '../fixtures/synth';
import { makeSsm } from './ssmHelpers';

const SR = 22050;

describe('stft', () => {
  it('has the right frame count and a Hann window', () => {
    expect(frameCount(22050, 512)).toBe(1 + 43);
    expect(frameCount(0, 512)).toBe(0);
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 9);
    expect(w[4]).toBeCloseTo(1, 9);
  });

  it('puts a sine in the right bin with amplitude about 1', () => {
    const bin = 100;
    const hz = (bin * SR) / 2048;
    const s = sine(hz, 1, SR, 1);
    const { mags, frames, bins } = stft(s);
    expect(bins).toBe(1025);
    const mid = Math.floor(frames / 2);
    const row = mags.subarray(mid * bins, (mid + 1) * bins);
    let peak = 0;
    for (let k = 0; k < bins; k++) if (row[k]! > row[peak]!) peak = k;
    expect(peak).toBe(bin);
    expect(row[peak]).toBeCloseTo(1, 1);
  });

  it('centres frames: a click at sample i*hop is strongest in frame i', () => {
    const s = new Float32Array(SR);
    s[512 * 10] = 1;
    const energies: number[] = [];
    forEachFrame(s, { frameSize: 2048, hop: 512 }, (_f, m) => energies.push(m.reduce((a, b) => a + b, 0)));
    const best = energies.indexOf(Math.max(...energies));
    expect(best).toBe(10);
  });
});

describe('onset strength', () => {
  it('flux is zero for a steady tone and large at a note onset', () => {
    const tone = new Float32Array(2 * SR);
    const t0 = SR; // note starts at 1 s
    for (let i = t0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const { mags, frames, bins } = stft(tone);
    const acc = new FluxAccumulator(bins);
    const flux: number[] = [];
    for (let f = 0; f < frames; f++) flux.push(acc.push(mags.subarray(f * bins, (f + 1) * bins)));
    const peakFrame = flux.indexOf(Math.max(...flux));
    expect(Math.abs(peakFrame - t0 / 512)).toBeLessThan(5);
    expect(flux[5]).toBe(0);
    expect(flux[frames - 5]!).toBeLessThan(Math.max(...flux) * 0.05);
  });

  it('normalises to unit variance and stays zero for silence', () => {
    const { mags, frames, bins } = stft(sine(300, 3, SR, 0.3));
    const o = onsetStrength(mags, frames, bins, SR / 512);
    expect(o.every((v) => v >= 0)).toBe(true);
    expect(normalizeOnset(new Float32Array(100), 43).every((v) => v === 0)).toBe(true);
    const x = Float32Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? 5 : 0.2));
    const n = normalizeOnset(x, 43);
    let mean = 0;
    let sq = 0;
    for (const v of n) {
      mean += v;
      sq += v * v;
    }
    mean /= n.length;
    expect(Math.sqrt(sq / n.length - mean * mean)).toBeCloseTo(1, 5);
  });

  it('movingAverage smooths with shrinking edges', () => {
    const y = movingAverage(Float32Array.from([0, 0, 10, 0, 0]), 3);
    expect(y[2]).toBeCloseTo(10 / 3, 5);
    expect(y[0]).toBeCloseTo(0, 5);
  });
});

describe('tempo helpers', () => {
  it('prior peaks at the centre tempo and is symmetric in octaves', () => {
    expect(tempoPrior(120)).toBe(1);
    expect(tempoPrior(60)).toBeCloseTo(tempoPrior(240), 9);
    expect(tempoPrior(60)).toBeLessThan(tempoPrior(100));
  });

  it('autocorrelation peaks at the period of a pulse train, including fractional lags', () => {
    const period = 21.5;
    const x = new Float32Array(2000);
    // onset peaks are a few frames wide (the STFT window is 4 frames long), so use small triangles
    for (let t = 10; t < x.length - 2; t += period) {
      const c = Math.round(t);
      x[c - 1]! += 0.5;
      x[c]! += 1;
      x[c + 1]! += 0.5;
    }
    const at = (lag: number): number => autocorrAt(x, lag);
    expect(at(21.5)).toBeGreaterThan(at(17));
    expect(at(21.5)).toBeGreaterThan(at(26));
    const r = estimateTempo(Float32Array.from(x, (v) => v * 3), 43.066);
    expect(Math.abs(r.bpm - (60 * 43.066) / period)).toBeLessThan(2);
  });

  it('falls back gracefully on empty or flat input', () => {
    expect(estimateTempo(new Float32Array(10), 43).confidence).toBe(0);
    expect(estimateTempo(new Float32Array(2000), 43).bpm).toBe(120);
  });
});

describe('beat tracker helpers', () => {
  it('tracks a regular pulse train and keeps the period', () => {
    const fr = 43.066;
    const period = fr / 2; // 120 BPM
    const onset = new Float32Array(1300);
    for (let t = 10; t < onset.length - 1; t += period) onset[Math.round(t)] = 1;
    const beats = trackBeatFrames(onset, fr, 120);
    expect(beats.length).toBeGreaterThan(50);
    for (let i = 1; i < beats.length; i++) expect(Math.abs(beats[i]! - beats[i - 1]! - period)).toBeLessThanOrEqual(1.5);
  });

  it('returns nothing for a silent envelope', () => {
    expect(trackBeatFrames(new Float32Array(500), 43, 120)).toEqual([]);
  });

  it('prepends beats missing at the start only when the grid hits zero', () => {
    const base = Array.from({ length: 10 }, (_, i) => 0.5 + i * 0.5);
    expect(prependStartBeats(base)).toHaveLength(11);
    expect(prependStartBeats(base)[0]).toBeCloseTo(0, 6);
    const late = base.map((t) => t + 0.2);
    expect(prependStartBeats(late)).toHaveLength(10); // 0.7 is not a multiple of the period
    const far = Array.from({ length: 10 }, (_, i) => 5 + i * 0.5);
    expect(prependStartBeats(far)).toHaveLength(10); // too many beats missing to fill in
  });

  it('computes tempo from beat times and bar starts from a phase', () => {
    expect(tempoFromBeats([0, 0.5, 1, 1.5, 2])).toBeCloseTo(120, 6);
    expect(tempoFromBeats([0, 1])).toBeNull();
    expect(barBeatIndices(10, 1, 3)).toEqual([1, 4, 7]);
  });
});

describe('frame features', () => {
  it('maps bins to pitch classes (A440 is pitch class 9)', () => {
    const map = chromaBinMap(SR, 2048);
    expect(map[Math.round((440 * 2048) / SR)]).toBe(9);
    expect(map[Math.round((261.63 * 2048) / SR)]).toBe(0); // C4
    expect(map[1]).toBe(-1); // below 55 Hz
    expect(map[map.length - 1]).toBe(-1); // above 5 kHz
  });

  it('builds a mel filterbank whose filters are normalised', () => {
    const fb = melFilterbank(SR, 2048);
    expect(fb).toHaveLength(40);
    for (const f of fb) expect(f.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
  });

  it('dct returns coefficients 1..count and ignores the DC term', () => {
    const flat = new Float32Array(40).fill(7);
    const c = dctCoefficients(flat, 13);
    expect(c).toHaveLength(13);
    for (const v of c) expect(Math.abs(v)).toBeLessThan(1e-4);
    const ramp = Float32Array.from({ length: 40 }, (_, i) => i);
    expect(Math.abs(dctCoefficients(ramp, 13)[0]!)).toBeGreaterThan(1);
  });

  it('beat-synchronous chroma finds the chord root and timbre is z-scored', () => {
    // a C major chord for 4 s then an F major chord for 4 s
    const n = 8 * SR;
    const x = new Float32Array(n);
    const add = (hz: number, from: number, to: number): void => {
      for (let i = from; i < to; i++) x[i]! += 0.2 * Math.sin((2 * Math.PI * hz * i) / SR);
    };
    for (const hz of [261.63, 329.63, 392]) add(hz, 0, 4 * SR);
    for (const hz of [349.23, 440, 523.25]) add(hz, 4 * SR, 8 * SR);
    const fd = computeFrameData(x, SR);
    const beats = Array.from({ length: 14 }, (_, i) => 0.5 + i * 0.5);
    const f = beatSyncFeatures(fd, beats);
    const argmax = (i: number): number => {
      let best = 0;
      for (let c = 1; c < CHROMA_BINS; c++) if (f.chroma[i * CHROMA_BINS + c]! > f.chroma[i * CHROMA_BINS + best]!) best = c;
      return best;
    };
    expect([0, 4, 7]).toContain(argmax(2));
    expect([5, 9, 0]).toContain(argmax(11));
    // unit-length chroma
    for (let i = 0; i < f.beats; i++) {
      let s = 0;
      for (let c = 0; c < CHROMA_BINS; c++) s += f.chroma[i * CHROMA_BINS + c]! ** 2;
      expect(s).toBeCloseTo(1, 4);
    }
    for (let d = 0; d < f.timbreDims; d++) {
      let mean = 0;
      for (let i = 0; i < f.beats; i++) mean += f.timbre[i * f.timbreDims + d]!;
      expect(Math.abs(mean / f.beats)).toBeLessThan(1e-4);
    }
    expect(f.dims).toBe(25);
  });
});

describe('self-similarity and sections', () => {
  it('delay embedding stacks the next beats and clamps at the end', () => {
    const f = Float32Array.from([1, 2, 3, 4]); // 4 beats, 1 dim
    const { data, dims } = delayEmbed(f, 4, 1, 2);
    expect(dims).toBe(3);
    expect(Array.from(data.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(data.subarray(9, 12))).toEqual([4, 4, 4]);
  });

  it('cosine similarity is 1 on the diagonal and symmetric', () => {
    const f = Float32Array.from([1, 0, 0, 1, 1, 0, 0, 1]); // 4 beats x 2 dims
    const { S, n } = selfSimilarity(f, 4, 2, 0);
    for (let i = 0; i < n; i++) expect(S[i * n + i]).toBeCloseTo(1, 5);
    expect(S[0 * n + 2]).toBeCloseTo(1, 5);
    expect(S[0 * n + 1]).toBeCloseTo(0, 5);
    expect(S[1 * n + 0]).toBe(S[0 * n + 1]);
  });

  it('novelty peaks at block boundaries', () => {
    const ssm = makeSsm('AABBAA', 16);
    const nov = noveltyCurve(ssm, 16);
    const peaks = pickPeaks(nov, 8);
    expect(peaks).toEqual([32, 64]);
  });

  it('peak picking respects the minimum gap and thresholds', () => {
    const c = new Float32Array(100);
    c[20] = 5;
    c[24] = 4;
    c[60] = 3;
    c[80] = 0.1;
    expect(pickPeaks(c, 8)).toEqual([20, 60]);
    expect(pickPeaks(new Float32Array(50), 8)).toEqual([]);
  });

  it('clusters similar segments and labels by first appearance', () => {
    const v = (...x: number[]): Float64Array => Float64Array.from(x);
    const ids = clusterSegments([v(1, 0), v(0, 1), v(1, 0.05), v(0, 1), v(-1, -1), v(1, 0)], [4, 4, 4, 4, 4, 4], 0.2);
    expect(ids).toEqual([0, 1, 0, 1, 2, 0]);
    expect(['A', 'B', 'Z', 'AA'].length).toBe(4);
    expect(labelName(0)).toBe('A');
    expect(labelName(25)).toBe('Z');
    expect(labelName(26)).toBe('A2');
  });

  it('finds sections in a block matrix and snaps them to bar lines', () => {
    const n = 96;
    const ssm = makeSsm('AABBAA', 16);
    const beats = Array.from({ length: n }, (_, i) => i * 0.5);
    const combined = new Float32Array(n * 2);
    const loud = new Float32Array(n).fill(-20);
    for (let i = 0; i < n; i++) {
      const b = Math.floor(i / 16) % 6 >= 2 && Math.floor(i / 16) % 6 < 4;
      combined[i * 2] = b ? 0 : 1;
      combined[i * 2 + 1] = b ? 1 : 0;
    }
    const features = { beats: n, chromaDims: 1, timbreDims: 1, chroma: new Float32Array(0), timbre: new Float32Array(0), loudness: loud, combined, dims: 2 };
    const barBeats = Array.from({ length: 24 }, (_, i) => i * 4);
    const res = findSections({ ssm, features, beats, barBeats, beatsPerBar: 4, duration: 48, delay: 0 });
    expect(res.sections.map((s) => s.label).join('')).toBe('ABA');
    expect(res.sections.map((s) => s.startBeat)).toEqual([0, 32, 64]);
    expect(res.sections[0]!.start).toBe(0);
    expect(res.sections[2]!.end).toBe(48);
    expect(res.boundaries).toEqual([0, 32, 64]);
    expect(res.sections.find((s) => s.label === 'A')!.hint).toBe('likely chorus');
  });
});
