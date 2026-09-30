import { describe, expect, it } from 'vitest';
import {
  countRuns,
  energyContinuity,
  findCandidates,
  lengthPreference,
  seamScore,
  starsFor,
  structureScore,
} from '../../src/analysis/candidates';
import { analyzeSignal } from '../../src/analysis/pipeline';
import type { Analysis } from '../../src/analysis/types';
import { synthSong } from '../fixtures/synth';
import type { SynthSong } from '../fixtures/synth';
import { makeSsm } from './ssmHelpers';

const SR = 22050;

function near(a: number, b: number, tol = 0.12): boolean {
  return Math.abs(a - b) <= tol;
}

/** True section boundaries between different letters, e.g. A|B. */
function boundaryTimes(song: SynthSong, pair?: [string, string]): number[] {
  const out: number[] = [];
  for (let i = 1; i < song.sections.length; i++) {
    const prev = song.sections[i - 1]!;
    const cur = song.sections[i]!;
    if (!pair || (pair.includes(prev.label) && pair.includes(cur.label) && prev.label !== cur.label)) {
      out.push(cur.start);
    }
  }
  return out;
}

const onAny = (t: number, times: number[]): boolean => times.some((x) => near(t, x));

describe('synthetic A B A B C A song', () => {
  const song = synthSong({ sampleRate: SR });
  const a: Analysis = analyzeSignal(song.samples, SR, 4);

  it('finds the tempo and sections', () => {
    expect(Math.abs(a.bpm - 120)).toBeLessThan(1);
    expect(a.sections.map((s) => s.label).join('')).toBe('ABABCA');
    // section starts are the true boundaries
    song.sections.forEach((s, i) => expect(near(a.sections[i]!.start, s.start, 0.1)).toBe(true));
    // A repeats the most: the only section marked as a likely chorus
    expect([...new Set(a.sections.filter((s) => s.hint).map((s) => s.label))]).toEqual(['A']);
  });

  it('ranks a candidate that starts and ends on A/B boundaries first', () => {
    const top = a.candidates[0]!;
    const ab = boundaryTimes(song, ['A', 'B']);
    expect(onAny(top.start, ab)).toBe(true);
    expect(onAny(top.end, ab)).toBe(true);
    expect(top.components.structure).toBe(1);
    expect(top.components.seam).toBeGreaterThan(0.9);
  });

  it('has a full A or A+B loop in the top 3', () => {
    const secs = song.sections;
    const fullA = secs.filter((s) => s.label === 'A').map((s) => [s.start, s.end] as const);
    const aPlusB: (readonly [number, number])[] = [];
    for (let i = 0; i + 1 < secs.length; i++) {
      if (secs[i]!.label === 'A' && secs[i + 1]!.label === 'B') aPlusB.push([secs[i]!.start, secs[i + 1]!.end]);
    }
    const wanted = [...fullA, ...aPlusB];
    const top3 = a.candidates.slice(0, 3);
    const hit = top3.some((c) => wanted.some(([s, e]) => near(c.start, s) && near(c.end, e, 0.6)));
    expect(hit).toBe(true);
  });

  it('gives every candidate bar-aligned, sane edges and a reason', () => {
    expect(a.candidates.length).toBeGreaterThan(3);
    expect(a.candidates.length).toBeLessThanOrEqual(12);
    const barSeconds = 2;
    for (const c of a.candidates) {
      expect(c.bars).toBeGreaterThanOrEqual(2);
      expect(c.bars).toBeLessThanOrEqual(32);
      expect(c.end - c.start).toBeGreaterThanOrEqual(4);
      expect(c.end - c.start).toBeLessThanOrEqual(0.5 * song.duration + 1e-6);
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(c.reason).toMatch(/Seam match \d+%/);
      expect(c.stars).toBeGreaterThanOrEqual(1);
      expect(c.stars).toBeLessThanOrEqual(5);
      // edges sit on bar lines: multiples of the 2 s bar (the song starts on a downbeat)
      expect(Math.abs(c.start / barSeconds - Math.round(c.start / barSeconds))).toBeLessThan(0.06);
      expect(c.endBeat - c.startBeat).toBe(c.bars * 4);
    }
    // sorted by score, and no heavy overlaps
    for (let i = 1; i < a.candidates.length; i++) {
      expect(a.candidates[i - 1]!.score).toBeGreaterThanOrEqual(a.candidates[i]!.score);
    }
    const top = a.candidates[0]!;
    expect(top.reason).toContain('sections');
  });

  it('still works when the song starts late and at another tempo', () => {
    const s2 = synthSong({ sampleRate: SR, leadIn: 1.3, bpm: 100 });
    const a2 = analyzeSignal(s2.samples, SR, 4);
    expect(Math.abs(a2.bpm - 100)).toBeLessThan(1);
    const ab = boundaryTimes(s2, ['A', 'B']);
    const top = a2.candidates[0]!;
    expect(onAny(top.start, ab)).toBe(true);
    expect(onAny(top.end, ab)).toBe(true);
  });

  it('works in 3/4 after the user switches the meter', () => {
    const s3 = synthSong({ sampleRate: SR, beatsPerBar: 3, bpm: 110, barsPerSection: 4 });
    const a3 = analyzeSignal(s3.samples, SR, 3);
    const ab = boundaryTimes(s3, ['A', 'B']);
    const top = a3.candidates[0]!;
    expect(onAny(top.start, ab)).toBe(true);
    expect(onAny(top.end, ab)).toBe(true);
  });
});

describe('sections on other structures and tempos', () => {
  const cases: [string, number, number][] = [
    ['ABCBA', 124, 6],
    ['ABAB', 100, 12],
    ['ABCABC', 90, 4],
  ];
  for (const [structure, bpm, barsPerSection] of cases) {
    it(`recovers ${structure} at ${bpm} BPM with ${barsPerSection}-bar sections`, () => {
      const song = synthSong({ sampleRate: SR, structure, bpm, barsPerSection });
      const a = analyzeSignal(song.samples, SR, 4);
      expect(a.sections.map((s) => s.label).join('')).toBe(structure);
      song.sections.forEach((s, i) => expect(near(a.sections[i]!.start, s.start, 0.15)).toBe(true));
      const top = a.candidates[0]!;
      const all = song.sections.map((s) => s.start);
      expect(onAny(top.start, all)).toBe(true);
      expect(onAny(top.end, [...all, song.sections[song.sections.length - 1]!.end])).toBe(true);
    });
  }

  it('analyses a five-minute song quickly', () => {
    const song = synthSong({ sampleRate: SR, structure: 'ABABCA'.repeat(6) });
    expect(song.duration).toBeGreaterThan(280);
    const t0 = performance.now();
    const a = analyzeSignal(song.samples, SR, 4);
    const seconds = (performance.now() - t0) / 1000;
    expect(a.candidates.length).toBeGreaterThan(3);
    // Budget from the spec: under 5 s for a five-minute song on a mid-range laptop.
    expect(seconds).toBeLessThan(5);
  });
});

describe('candidate components', () => {
  it('seam score averages the diagonal around the jump', () => {
    // 20 beats; beats i and i+10 are identical, all else orthogonal-ish
    const n = 20;
    const S = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i * n + j] = i === j || Math.abs(i - j) === 10 ? 1 : 0.1;
    const ssm = { S, n };
    expect(seamScore(ssm, 4, 14, 4)).toBeCloseTo(1, 6);
    expect(seamScore(ssm, 4, 12, 4)).toBeCloseTo(0.1, 6);
    // missing context at the very start lowers the score (only half the window exists)
    expect(seamScore(ssm, 0, 10, 4)).toBeCloseTo(0.75, 6);
  });

  it('structure score: 1 for both edges, 0.5 for one, 0 for none', () => {
    const b = new Set([0, 16, 32]);
    expect(structureScore(0, 16, b)).toBe(1);
    expect(structureScore(16, 24, b)).toBe(0.5);
    expect(structureScore(4, 20, b)).toBe(0);
  });

  it('energy continuity maps a 6 dB jump to zero', () => {
    const loud = Float32Array.from([-20, -20, -20, -26, -23]);
    expect(energyContinuity(loud, 0, 4, 6)).toBe(0);
    expect(energyContinuity(loud, 0, 3, 6)).toBe(1);
    expect(energyContinuity(loud, 0, 5, 6)).toBeCloseTo(0.5, 6);
    expect(energyContinuity(Float32Array.from([-10, -30]), 0, 2, 6)).toBe(0);
  });

  it('length preference: 4, 8, 16 best; even next; odd least', () => {
    expect([4, 8, 16].map((b) => lengthPreference(b))).toEqual([1, 1, 1]);
    expect(lengthPreference(6)).toBe(0.7);
    expect(lengthPreference(2)).toBe(0.7);
    expect(lengthPreference(5)).toBe(0.4);
  });

  it('stars rise with the score', () => {
    expect(starsFor(0.1)).toBe(1);
    expect(starsFor(0.5)).toBe(3);
    expect(starsFor(0.9)).toBe(5);
  });

  it('counts label runs', () => {
    expect(countRuns(['A', 'B', 'A', 'B', 'C', 'A'], ['A'])).toBe(3);
    expect(countRuns(['A', 'B', 'A', 'B', 'C', 'A'], ['A', 'B'])).toBe(2);
    expect(countRuns(['A', 'A', 'A'], ['A', 'A'])).toBe(1);
  });

  it('suppresses candidates that overlap a better one by more than 60%', () => {
    // A trivial matrix where every pair looks the same: ranking is decided by length and structure only.
    const n = 80;
    const S = new Float32Array(n * n).fill(0.9);
    const beats = Array.from({ length: n }, (_, i) => i * 0.5);
    const loud = new Float32Array(n).fill(-20);
    const feats = { beats: n, chromaDims: 12, timbreDims: 13, chroma: new Float32Array(0), timbre: new Float32Array(0), loudness: loud, combined: new Float32Array(0), dims: 25 };
    const barBeats = Array.from({ length: 20 }, (_, i) => i * 4);
    const out = findCandidates({
      ssm: { S, n },
      features: feats,
      beats,
      barBeats,
      beatsPerBar: 4,
      sections: [],
      boundaries: [],
      duration: 40,
    });
    const iou = (x: { startBeat: number; endBeat: number }, y: { startBeat: number; endBeat: number }): number => {
      const inter = Math.max(0, Math.min(x.endBeat, y.endBeat) - Math.max(x.startBeat, y.startBeat));
      return inter / (x.endBeat - x.startBeat + (y.endBeat - y.startBeat) - inter);
    };
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(iou(out[i]!, out[j]!)).toBeLessThanOrEqual(0.6);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.length).toBeGreaterThan(2);
  });
});

// keep the helper import used (it is exercised in sections.test.ts as well)
void makeSsm;
