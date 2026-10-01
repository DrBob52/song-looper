import { describe, expect, it } from 'vitest';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import {
  buildHarmonyModel,
  chromaSimilarity,
  harmonyScore,
  loopHarmony,
  makeRng,
  transitionEvidence,
} from '../../src/analysis/harmony';
import type { ChromaSimilarity } from '../../src/analysis/harmony';
import { SONG1, SONG2, STATIC_SONG } from '../fixtures/synth';
import { analyseChordSong } from './chordHelpers';

/** A chroma similarity matrix from a string of "chord ids": equal ids are identical beats, others are `other` apart. */
function simFromLabels(labels: string, other = 0.2): ChromaSimilarity {
  const n = labels.length;
  const C = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) C[i * n + j] = labels[i] === labels[j] ? 1 : other;
  return { C, n };
}

const cfg = ANALYSIS_CONFIG.harmony;

describe('chroma similarity', () => {
  it('is the cosine of the beat chroma, symmetric, 1 on the diagonal', () => {
    const chroma = Float32Array.from([1, 0, 0, 0, /**/ 0, 1, 0, 0, /**/ 1, 1, 0, 0, /**/ 0, 0, 0, 0]);
    const { C, n } = chromaSimilarity(chroma, 4, 4);
    expect(n).toBe(4);
    expect(C[0]).toBeCloseTo(1, 6);
    expect(C[0 * 4 + 1]).toBeCloseTo(0, 6);
    expect(C[0 * 4 + 2]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(C[2 * 4 + 0]).toBe(C[0 * 4 + 2]);
    // a silent beat is similar to nothing, not even itself
    expect(C[3 * 4 + 3]).toBe(0);
    expect(C[3 * 4 + 0]).toBe(0);
  });
});

describe('transition evidence', () => {
  // beats: A A A A | B B B B | A A A A | B B B B | C C C C
  const labels = 'AAAABBBBAAAABBBBCCCC';
  const model = buildHarmonyModel(simFromLabels(labels), 4, { ...cfg, sampleCount: 300 });

  it('the natural continuation always has evidence 1', () => {
    for (const x of [3, 7, 11]) expect(transitionEvidence(model, x, x + 1).value).toBe(1);
    expect(harmonyScore(model, 5, 6)).toBe(1);
  });

  it('finds a chord change that the song makes elsewhere, and rejects one it never makes', () => {
    // B -> A happens (beats 7 -> 8, 15 -> ...); A -> C never does
    const natural = transitionEvidence(model, 7, 0); // last beat of B, back to the start of A
    expect(natural.value).toBeGreaterThan(0.95);
    expect(natural.at).toBe(8);
    const never = transitionEvidence(model, 11, 16); // end of A into the start of C
    expect(never.value).toBeLessThan(0.5);
  });

  it('skips windows that run off the ends and never matches a seam with itself', () => {
    // t = y is the trivial match (the continuation matches itself): a seam whose lead-in is nothing like
    // the music before y must not score just because of it.
    const lone = buildHarmonyModel(simFromLabels('AAAABBBBCCCC'), 4, { ...cfg, sampleCount: 50 });
    const e = transitionEvidence(lone, 3, 8); // A end -> C start; C never follows A
    expect(e.value).toBeLessThan(0.5);
    // windows at t < w or t > n - w are not considered
    expect(transitionEvidence(lone, 3, 0).at).not.toBe(0);
    expect(transitionEvidence(lone, 3, 0).at).toBeGreaterThanOrEqual(cfg.windowBeats);
  });

  it('uses the mean of the two best matches a bar apart, waived as the best match nears an exact repeat', () => {
    // A bar of "A" is followed by "B" exactly once (beats 3 -> 4), and by "b", a look-alike of B (0.8), once more.
    const labels2 = 'AAAA' + 'BBBB' + 'XXXX' + 'AAAA' + 'bbbb' + 'YYYY' + 'ZZZZ' + 'BBBB';
    const n = labels2.length;
    const C = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const l1 = labels2[i]!;
        const l2 = labels2[j]!;
        C[i * n + j] = l1 === l2 ? 1 : (l1 === 'B' && l2 === 'b') || (l1 === 'b' && l2 === 'B') ? 0.8 : 0.1;
      }
    }
    const sim = { C, n };
    const x = 3; // last beat of the first A bar
    const y = 28; // start of the last B bar: not where the song goes after that A
    // Plain mean of the top two: (1.0 + 0.8) / 2. The waiver is switched off by making "exact" unreachable.
    const plain = buildHarmonyModel(sim, 4, { ...cfg, sampleCount: 20, exactMatch: 1.01, corroborateBelow: 1 });
    const e = transitionEvidence(plain, x, y);
    expect(e.at).toBe(4);
    expect(e.value).toBeCloseTo(0.9, 5);
    // With the default waiver an exact repeat (both windows >= exactMatch) stands alone.
    const waived = buildHarmonyModel(sim, 4, { ...cfg, sampleCount: 20 });
    expect(transitionEvidence(waived, x, y).value).toBeCloseTo(1, 6);
    // Only one match at all: nothing to average with.
    const only = buildHarmonyModel(sim, 4, { ...cfg, sampleCount: 20, topMatches: 1 });
    expect(transitionEvidence(only, x, y).value).toBeCloseTo(1, 6);
  });

  it('keeps the second match in the average when the best one is only partial', () => {
    // Same song, but the one follow-up is only 0.9 similar: no waiver, mean(0.9, 0.8)
    const labels2 = 'AAAA' + 'cccc' + 'XXXX' + 'AAAA' + 'bbbb' + 'YYYY' + 'ZZZZ' + 'BBBB';
    const n = labels2.length;
    const C = new Float32Array(n * n);
    const sim2 = (l1: string, l2: string): number =>
      l1 === l2 ? 1 : (l1 + l2 === 'Bc' || l1 + l2 === 'cB') ? 0.85 : (l1 + l2 === 'Bb' || l1 + l2 === 'bB') ? 0.75 : 0.1;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) C[i * n + j] = sim2(labels2[i]!, labels2[j]!);
    const m = buildHarmonyModel({ C, n }, 4, { ...cfg, sampleCount: 20 });
    const e = transitionEvidence(m, 3, 28);
    expect(e.at).toBe(4);
    // best 0.85 (< corroborateBelow 0.9): plain mean of 0.85 and 0.75
    expect(e.value).toBeCloseTo(0.8, 5);
  });

  it('normalises against the song: a harmonically static song scores 1 everywhere', () => {
    const flat = buildHarmonyModel(simFromLabels('AAAAAAAAAAAAAAAAAAAA', 1), 4, { ...cfg, sampleCount: 100 });
    expect(flat.isStatic).toBe(true);
    for (const [x, y] of [[3, 0], [7, 12], [10, 2], [19, 0]] as const) expect(harmonyScore(flat, x, y)).toBe(1);
    expect(loopHarmony(flat, 4, 16)).toBe(1);
  });

  it('is deterministic', () => {
    const a = buildHarmonyModel(simFromLabels(labels), 4, { ...cfg, sampleCount: 300 });
    const b = buildHarmonyModel(simFromLabels(labels), 4, { ...cfg, sampleCount: 300 });
    expect([a.p50, a.p95]).toEqual([b.p50, b.p95]);
    const r1 = makeRng(5);
    const r2 = makeRng(5);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it('copes with a tiny song', () => {
    const tiny = buildHarmonyModel(simFromLabels('AB'), 4);
    expect(tiny.isStatic).toBe(true);
    expect(harmonyScore(tiny, 1, 0)).toBe(1);
  });
});

describe('harmony of the chord-progression songs (SPEC-seams.md section 7)', () => {
  const song1 = analyseChordSong(SONG1);
  const song2 = analyseChordSong(SONG2);

  it('analyses the songs as intended', () => {
    for (const s of [song1, song2]) {
      expect(Math.abs(s.analysis.bpm - 120)).toBeLessThan(1);
      expect(s.analysis.barPhase).toBe(0);
      expect(s.session.harmony).not.toBeNull();
      expect(s.session.harmony!.isStatic).toBe(false);
    }
  });

  it('song 1: loop A alone ends on F and returns to C, which never happens: harmony < 0.35', () => {
    const m = song1.session.harmony!;
    const [a, b] = song1.span(0);
    expect(b - a).toBe(16);
    expect(loopHarmony(m, a, b)).toBeLessThan(0.35);
    // and the second A, which ends on F as well, before B
    const [a2, b2] = song1.span(2);
    expect(loopHarmony(m, a2, b2)).toBeLessThan(0.35);
  });

  it('song 1: loop A+B ends on G and returns to C, which does happen: harmony > 0.8', () => {
    const m = song1.session.harmony!;
    const [a, b] = song1.span(0, 1);
    expect(b - a).toBe(32);
    expect(loopHarmony(m, a, b)).toBeGreaterThan(0.8);
  });

  it('song 2 (adds C = Am F C G, which contains F -> C): the same loop A now scores > 0.7', () => {
    const m = song2.session.harmony!;
    // song 2 is C A B A B: the two A sections are sections 1 and 3
    for (const i of [1, 3]) {
      const [a, b] = song2.span(i);
      expect(b - a).toBe(16);
      expect(loopHarmony(m, a, b)).toBeGreaterThan(0.7);
    }
  });

  it('a harmonically static song is harmony 1 for every seam and nothing crashes', () => {
    const s = analyseChordSong(STATIC_SONG);
    const m = s.session.harmony;
    expect(m).not.toBeNull();
    expect(m!.isStatic).toBe(true);
    const n = m!.n;
    for (let x = 1; x < n; x += 5) for (let y = 0; y < n; y += 7) expect(harmonyScore(m!, x, y)).toBe(1);
    expect(s.analysis.candidates.length).toBeGreaterThan(0);
    for (const c of s.analysis.candidates) expect(c.components.harmony).toBe(1);
  });

  it('puts the harmony of every suggestion in its components and its reason', () => {
    for (const c of song1.analysis.candidates) {
      expect(c.components.harmony).toBeGreaterThanOrEqual(0);
      expect(c.components.harmony).toBeLessThanOrEqual(1);
      expect(c.components.seam).toBeCloseTo(
        ANALYSIS_CONFIG.candidates.seamContextWeight * c.components.contextMatch +
          ANALYSIS_CONFIG.candidates.seamHarmonyWeight * c.components.harmony!,
        6,
      );
      if (c.components.harmony! >= cfg.good) expect(c.reason).toContain('chords lead back cleanly');
      if (c.components.harmony! < cfg.poor) expect(c.reason).toContain("chord change at the seam isn't in the song");
    }
  });
});
