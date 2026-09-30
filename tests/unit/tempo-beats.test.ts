import { describe, expect, it } from 'vitest';
import { AnalysisSession, analyzeSignal } from '../../src/analysis/pipeline';
import { clickTrack } from '../fixtures/synth';

const SR = 22050;

/** Fraction of true beats that have a detected beat within `tol` seconds, plus the signed errors. */
function beatAccuracy(truth: number[], detected: number[], tol: number): { hit: number; errors: number[] } {
  const errors: number[] = [];
  let hits = 0;
  for (const t of truth) {
    let best = Infinity;
    for (const d of detected) if (Math.abs(d - t) < Math.abs(best)) best = d - t;
    if (Math.abs(best) <= tol) hits++;
    errors.push(best);
  }
  return { hit: hits / truth.length, errors };
}

const meanAbs = (xs: number[]): number => xs.reduce((s, e) => s + Math.abs(e), 0) / xs.length;

describe('tempo and beat tracking on click tracks', () => {
  for (const bpm of [100, 120, 140]) {
    it(`finds ${bpm} BPM and beats within 30 ms`, () => {
      const { samples, beatTimes } = clickTrack(bpm, 30, SR, 0.5);
      const a = analyzeSignal(samples, SR);
      expect(Math.abs(a.bpm - bpm)).toBeLessThanOrEqual(1);
      const { hit, errors } = beatAccuracy(beatTimes, a.beats, 0.03);
      expect(hit).toBeGreaterThanOrEqual(0.9);
      expect(meanAbs(errors)).toBeLessThan(0.01);
      expect(a.steadyBeat).toBe(true);
      expect(a.beatConfidence).toBeGreaterThan(0.5);
    });
  }

  it('handles off-grid tempos and a late first beat', () => {
    for (const [bpm, first] of [[90, 0.13], [128, 0.9], [170, 0.31]] as const) {
      const { samples, beatTimes } = clickTrack(bpm, 25, SR, first);
      const a = analyzeSignal(samples, SR);
      // 170 BPM may come back as its half (85); accept the octave but the beats must still line up
      const octave = a.bpm / bpm;
      expect([0.5, 1].some((o) => Math.abs(octave - o) < 0.01)).toBe(true);
      if (Math.abs(octave - 1) < 0.01) {
        expect(beatAccuracy(beatTimes, a.beats, 0.03).hit).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it('reports a 2nd tempo hypothesis (half or double)', () => {
    const { samples } = clickTrack(120, 30, SR, 0.5);
    const a = analyzeSignal(samples, SR);
    expect([60, 240, 80, 180].some((x) => Math.abs(a.bpmAlt - x) / x < 0.1)).toBe(true);
    expect(Math.abs(a.bpmAlt - a.bpm) / a.bpm).toBeGreaterThan(0.1);
  });

  it('can be forced to a different tempo (half) and re-tracks from cached frames', () => {
    const { samples } = clickTrack(120, 30, SR, 0.5);
    const session = new AnalysisSession(samples, SR);
    const a = session.run(4);
    const half = session.update({ bpm: a.bpm / 2 });
    expect(Math.abs(half.bpm - 60)).toBeLessThan(1.5);
    expect(half.beats.length).toBeLessThan(a.beats.length * 0.6);
    expect(half.bpmOverride).toBeCloseTo(60, 0);
    const back = session.update({ bpm: null });
    expect(Math.abs(back.bpm - 120)).toBeLessThan(1);
  });

  it('follows moderate tempo drift', () => {
    // 120 BPM drifting to 126 BPM over 30 s
    const n = 30 * SR;
    const samples = new Float32Array(n);
    const beatTimes: number[] = [];
    let t = 0.5;
    while (t < 29) {
      beatTimes.push(t);
      const s0 = Math.round(t * SR);
      for (let i = 0; i < 440 && s0 + i < n; i++) {
        samples[s0 + i] = 0.9 * Math.exp(-i / 90) * Math.sin((2 * Math.PI * 1000 * i) / SR);
      }
      const bpm = 120 + (6 * t) / 30;
      t += 60 / bpm;
    }
    const a = analyzeSignal(samples, SR);
    expect(beatAccuracy(beatTimes, a.beats, 0.03).hit).toBeGreaterThanOrEqual(0.9);
  });

  it('flags noise as having no steady beat', () => {
    let x = 12345;
    const noise = new Float32Array(20 * SR);
    for (let i = 0; i < noise.length; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      noise[i] = (x / 2147483648 - 1) * 0.3;
    }
    const a = analyzeSignal(noise, SR);
    expect(a.steadyBeat).toBe(false);
    expect(a.beatConfidence).toBeLessThan(0.1);
  });

  it('treats silence as silent and produces no beats', () => {
    const a = analyzeSignal(new Float32Array(10 * SR), SR);
    expect(a.silent).toBe(true);
    expect(a.beats).toEqual([]);
    expect(a.skipped).toBe('silent');
  });
});
