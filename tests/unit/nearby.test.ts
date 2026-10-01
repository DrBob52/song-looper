import { describe, expect, it } from 'vitest';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import { scoreLoop } from '../../src/analysis/candidates';
import { loopHarmony } from '../../src/analysis/harmony';
import { findNearbyLoop } from '../../src/analysis/nearby';
import { SONG1, SONG2 } from '../fixtures/synth';
import { analyseChordSong } from './chordHelpers';

const cfg = ANALYSIS_CONFIG.nearby;

describe('nearby loops with a cleaner chord change (SPEC-seams.md 4)', () => {
  const song1 = analyseChordSong(SONG1);
  const beats = song1.analysis.beats;
  const report = (start: number, end: number, extra: { minStart?: number; maxEnd?: number } = {}) =>
    song1.session.seamReport([{ id: 'x', start, end, ...extra }])[0]!;

  it('offers one when the loop ends on a chord change the song never makes', () => {
    // bars 0-6 end on F and return to C (never); one bar further the loop ends on G, which does lead back to C
    const r = report(0, 14);
    expect(r.harmony!).toBeLessThan(cfg.under);
    const n = r.nearby!;
    expect(n).not.toBeNull();
    expect(n.harmony).toBeGreaterThanOrEqual(cfg.minHarmony);
    expect(n.harmony).toBeGreaterThan(r.harmony! + cfg.minGain);
    expect(n.start).toBe(beats[n.startBeat]);
    expect(n.end).toBe(beats[n.endBeat]);
    // C G Am F Dm Em F G: 8 bars
    expect(n.start).toBeCloseTo(0, 1);
    expect(n.end).toBeCloseTo(16, 1);
    expect(n.bars).toBe(8);
  });

  it('keeps the start within a bar, the end within two, and whole bars long', () => {
    const starts = [0, 2, 4];
    for (const s of starts) {
      for (const len of [8, 10, 12]) {
        const r = report(s, s + len);
        if (!r.nearby) continue;
        const n = r.nearby;
        const a = beats.findIndex((t) => Math.abs(t - s) < 0.1);
        const b = beats.findIndex((t) => Math.abs(t - (s + len)) < 0.1);
        expect(Math.abs(n.startBeat - a)).toBeLessThanOrEqual(4);
        expect(Math.abs(n.endBeat - b)).toBeLessThanOrEqual(8);
        expect((n.endBeat - n.startBeat) % 4).toBe(0);
        expect(n.bars).toBe((n.endBeat - n.startBeat) / 4);
        expect(n.endBeat).toBeGreaterThan(n.startBeat);
      }
    }
  });

  it('offers nothing when the harmony is already fine', () => {
    const song2 = analyseChordSong(SONG2);
    const a = song2.song.sections[1]!; // A in song 2 (C A B A B): its chord change back is in the song
    const [r] = song2.session.seamReport([{ id: 'x', start: a.start, end: a.end }]);
    expect(r!.harmony!).toBeGreaterThan(cfg.under);
    expect(r!.nearby).toBeNull();
    const ab = report(0, 16); // A+B in song 1: G -> C is in the song
    expect(ab.harmony!).toBeGreaterThan(cfg.under);
    expect(ab.nearby).toBeNull();
  });

  it('stays inside the room the loop has', () => {
    // the free space ends at 14 s: the 8-bar loop that ends at 16 s is not allowed
    const r = report(0, 14, { maxEnd: 14.01 });
    expect(r.nearby === null || r.nearby.end <= 14.01).toBe(true);
    const limited = report(0, 14, { minStart: 0, maxEnd: 14.01 });
    if (limited.nearby) expect(limited.nearby.end).toBeLessThanOrEqual(14.01);
  });

  it('maximises harmony and breaks ties with the loop score', () => {
    const r = report(0, 14);
    const n = r.nearby!;
    const model = song1.session.harmony!;
    const ctx = {
      ssm: song1.session.similarity!,
      features: song1.session.beatFeatures!,
      // the score tie-break sees the section boundaries the analysis found
      boundaries: new Set<number>([0, ...song1.analysis.sections.map((x) => x.startBeat)]),
      harmony: model,
    };
    // brute force over every whole-bar neighbour: start within a bar of beat 0, end within two bars of beat 28
    const a = 0;
    const b = song1.beat(14);
    const all: { a2: number; b2: number; h: number; score: number }[] = [];
    for (let a2 = Math.max(0, a - 4); a2 <= a + 4; a2++) {
      for (let b2 = b - 8; b2 <= b + 8; b2++) {
        if (b2 <= a2 || (b2 - a2) % 4 !== 0 || (a2 === a && b2 === b)) continue;
        all.push({ a2, b2, h: loopHarmony(model, a2, b2), score: scoreLoop(ctx, a2, b2, 4).score });
      }
    }
    const bestH = Math.max(...all.map((x) => x.h));
    expect(n.harmony).toBeCloseTo(bestH, 6);
    const tied = all.filter((x) => Math.abs(x.h - bestH) <= cfg.tie);
    expect(tied.length).toBeGreaterThan(1); // harmony saturates at 1: the score has to decide
    const bestScore = Math.max(...tied.map((x) => x.score));
    expect(n.score).toBeCloseTo(bestScore, 6);
  });

  it('needs a harmony model and a steady beat', () => {
    expect(
      findNearbyLoop({
        harmony: song1.session.harmony!,
        score: { ssm: song1.session.similarity!, features: song1.session.beatFeatures!, boundaries: new Set() },
        beats,
        beatsPerBar: 4,
        a: 0,
        b: 28,
        currentHarmony: 0.9, // fine already
        minStart: 0,
        maxEnd: 1e9,
      }),
    ).toBeNull();
  });
});
