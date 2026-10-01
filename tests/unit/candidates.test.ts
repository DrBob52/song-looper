import { describe, expect, it } from 'vitest';
import {
  contextMatch,
  countRuns,
  energyContinuity,
  findCandidates,
  lengthPreference,
  scoreLoop,
  seamScore,
  starsFor,
  structureScore,
} from '../../src/analysis/candidates';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import type { HarmonyModel } from '../../src/analysis/harmony';
import { analyzeSignal } from '../../src/analysis/pipeline';
import type { Analysis, Section } from '../../src/analysis/types';
import { SONG1, SONG2, synthSong } from '../fixtures/synth';
import type { SynthSong } from '../fixtures/synth';
import { analyseChordSong } from './chordHelpers';
import type { AnalysedChordSong } from './chordHelpers';
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

describe('context match (SPEC-seams.md 6)', () => {
  // 40 beats. Beats 0..19 and 20..39 are the same music, so a jump from b = 30 to a = 10 matches on both sides.
  const n = 40;
  const S = new Float32Array(n * n).fill(0.1);
  for (let i = 0; i < n; i++) S[i * n + i] = 1;
  const set = (i: number, j: number, v: number): void => {
    S[i * n + j] = v;
    S[j * n + i] = v;
  };

  it('takes the better of the lead-in and the continuation, not both', () => {
    // continuation only: S[a + j][b + j] high, lead-in low
    for (let j = 0; j < 4; j++) set(10 + j, 30 + j, 0.9);
    expect(contextMatch({ S, n }, 10, 30, 4)).toBeCloseTo(0.9, 5);
    // lead-in only: S[a - 1 - j][b - 1 - j] high
    const S2 = new Float32Array(n * n).fill(0.1);
    for (let i = 0; i < n; i++) S2[i * n + i] = 1;
    for (let j = 0; j < 4; j++) S2[(10 - 1 - j) * n + (30 - 1 - j)] = 0.8;
    expect(contextMatch({ S: S2, n }, 10, 30, 4)).toBeCloseTo(0.8, 5);
    // neither
    expect(contextMatch({ S: new Float32Array(n * n).fill(0.1), n }, 10, 30, 4)).toBeCloseTo(0.1, 5);
  });

  it('a missing side (loop at the start of the song) leaves the other side to decide', () => {
    const S3 = new Float32Array(n * n).fill(0.1);
    for (let j = 0; j < 4; j++) S3[(0 + j) * n + (20 + j)] = 1;
    expect(contextMatch({ S: S3, n }, 0, 20, 4)).toBeCloseTo(1, 5);
  });

  it('seam = 0.5 * context + 0.5 * harmony, and the context alone without a harmony model', () => {
    const ssm = { S, n };
    const features = { loudness: new Float32Array(n).fill(-20) };
    const boundaries = new Set<number>();
    const noHarmony = scoreLoop({ ssm, features, boundaries }, 10, 30, 4);
    expect(noHarmony.components.seam).toBeCloseTo(noHarmony.components.contextMatch, 9);
    expect(noHarmony.components.harmony).toBeUndefined();
    const fake = { isStatic: true } as unknown as HarmonyModel; // static: harmony 1
    const withHarmony = scoreLoop({ ssm, features, boundaries, harmony: fake }, 10, 30, 4);
    expect(withHarmony.components.harmony).toBe(1);
    expect(withHarmony.components.seam).toBeCloseTo(
      ANALYSIS_CONFIG.candidates.seamContextWeight * withHarmony.components.contextMatch +
        ANALYSIS_CONFIG.candidates.seamHarmonyWeight,
      9,
    );
  });
});

describe('suggestions use the harmonic transition model (SPEC-seams.md 6 and 7)', () => {
  /** Candidates for a chord song scored against its true sections (the section detector cannot place the A|B edge here). */
  function rankWithTrueSections(a: AnalysedChordSong): { starts: number[]; list: ReturnType<typeof findCandidates> } {
    const { song, session, analysis } = a;
    const boundaries = song.sections.map((x) => a.beat(x.start));
    const sections: Section[] = song.sections.map((x, i) => ({
      start: x.start,
      end: x.end,
      label: x.label,
      startBeat: boundaries[i]!,
      endBeat: boundaries[i + 1] ?? analysis.beats.length,
    }));
    const list = findCandidates({
      ssm: session.similarity!,
      features: session.beatFeatures!,
      beats: analysis.beats,
      barBeats: session.barBeats(),
      beatsPerBar: 4,
      sections,
      boundaries,
      duration: analysis.duration,
      harmony: session.harmony,
    });
    const starts = song.sections.filter((x) => x.label === 'A').map((x) => x.start);
    return { starts, list };
  }
  const isLoopA = (a: AnalysedChordSong, c: { start: number; end: number }): boolean =>
    a.song.sections.some((x) => x.label === 'A' && Math.abs(c.start - x.start) < 0.1 && Math.abs(c.end - x.end) < 0.1);

  it('song 2: loop A alone appears in the top 5', () => {
    const song2 = analyseChordSong(SONG2);
    const { list } = rankWithTrueSections(song2);
    const rank = list.findIndex((c) => isLoopA(song2, c));
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(5);
    expect(list[rank]!.components.harmony).toBeGreaterThan(0.7);
    expect(list[rank]!.reason).toContain('chords lead back cleanly');
  });

  it('song 1: loop A alone does not (its chord change back to C is not in the song)', () => {
    const song1 = analyseChordSong(SONG1);
    const { list } = rankWithTrueSections(song1);
    const rank = list.findIndex((c) => isLoopA(song1, c));
    expect(rank === -1 || rank >= 5).toBe(true);
    // wherever it is scored, its harmony is low and the reason says so
    const all = findCandidates({
      ssm: song1.session.similarity!,
      features: song1.session.beatFeatures!,
      beats: song1.analysis.beats,
      barBeats: song1.session.barBeats(),
      beatsPerBar: 4,
      sections: [],
      boundaries: [],
      duration: song1.analysis.duration,
      harmony: song1.session.harmony,
      cfg: { ...ANALYSIS_CONFIG.candidates, maxCandidates: 1000, nmsOverlap: 2 },
    });
    const a = all.find((c) => c.startBeat === song1.beat(0) && c.bars === 4)!;
    expect(a.components.harmony).toBeLessThan(0.35);
    expect(a.reason).toContain("chord change at the seam isn't in the song");
  });

  it('whole sections whose chord change is in the song beat the same loops when it is not', () => {
    const song1 = analyseChordSong(SONG1);
    const song2 = analyseChordSong(SONG2);
    const score = (a: AnalysedChordSong, section: number): number => {
      const [from, to] = a.span(section);
      return scoreLoop(
        {
          ssm: a.session.similarity!,
          features: a.session.beatFeatures!,
          boundaries: new Set(a.song.sections.map((x) => a.beat(x.start))),
          harmony: a.session.harmony,
        },
        from,
        to,
        4,
      ).score;
    };
    // song 1: A is section 0; song 2 (C A B A B): A is section 1
    expect(score(song2, 1)).toBeGreaterThan(score(song1, 0) + 0.1);
  });
});

// keep the helper import used (it is exercised in sections.test.ts as well)
void makeSsm;
