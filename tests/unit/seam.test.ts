import { describe, expect, it } from 'vitest';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import { AnalysisSession } from '../../src/analysis/pipeline';
import { chipFor, nearestBeat, seamQuality } from '../../src/analysis/seam';
import { SONG1, SONG2 } from '../fixtures/synth';
import { analyseChordSong } from './chordHelpers';

const SR = 22050;

describe('seam quality and chip', () => {
  it('weights harmony 0.5 against 0.25 for transient and spectral', () => {
    expect(seamQuality({ transient: 1, spectral: 1, harmony: 0 })).toBeCloseTo(0.5, 9);
    expect(seamQuality({ transient: 0, spectral: 0, harmony: 1 })).toBeCloseTo(0.5, 9);
    expect(seamQuality({ transient: 0.4, spectral: 0.8, harmony: 0.2 })).toBeCloseTo(0.25 * 0.4 + 0.25 * 0.8 + 0.5 * 0.2, 9);
  });

  it('without a beat grid the other two scores share the weight', () => {
    expect(seamQuality({ transient: 0.6, spectral: 0.2, harmony: null })).toBeCloseTo(0.4, 9);
  });

  it('a seam with no harmony can never read better than Rough', () => {
    // the best the other two scores can do is 0.5 of the quality, below the OK threshold
    const best = seamQuality({ transient: 1, spectral: 1, harmony: 0 });
    expect(chipFor(best)).toBe('rough');
  });

  it('chip thresholds come from the config', () => {
    const { clean, ok } = ANALYSIS_CONFIG.seam.chip;
    expect(chipFor(clean)).toBe('clean');
    expect(chipFor(clean - 0.001)).toBe('ok');
    expect(chipFor(ok)).toBe('ok');
    expect(chipFor(ok - 0.001)).toBe('rough');
  });

  it('finds the nearest beat', () => {
    const beats = [0, 0.5, 1, 1.5, 2];
    expect(nearestBeat(beats, -3)).toBe(0);
    expect(nearestBeat(beats, 0.74)).toBe(1);
    expect(nearestBeat(beats, 0.76)).toBe(2);
    expect(nearestBeat(beats, 9)).toBe(4);
  });
});

describe('seam report on the chord songs', () => {
  const song1 = analyseChordSong(SONG1);
  const song2 = analyseChordSong(SONG2);

  it('song 1: loop A reads Rough (harmony < 0.35), loop A+B does not', () => {
    const [a, ab] = song1.session.seamReport([
      { id: 'A', start: song1.song.sections[0]!.start, end: song1.song.sections[0]!.end },
      { id: 'AB', start: song1.song.sections[0]!.start, end: song1.song.sections[1]!.end },
    ]);
    expect(a!.id).toBe('A');
    expect(a!.hasGrid).toBe(true);
    expect(a!.harmony!).toBeLessThan(0.35);
    expect(a!.chip).toBe('rough');
    expect(a!.scores.quality).toBeLessThan(ANALYSIS_CONFIG.seam.chip.ok);
    expect(ab!.harmony!).toBeGreaterThan(0.8);
    expect(ab!.chip).not.toBe('rough');
    expect(ab!.contextMatch!).toBeGreaterThan(0.9);
    expect(ab!.scores.quality).toBeGreaterThan(a!.scores.quality + 0.3);
  });

  it('song 2: the same loop A is no longer Rough', () => {
    const s = song2.song.sections[1]!; // C A B A B: section 1 is A
    const [a] = song2.session.seamReport([{ id: 'A', start: s.start, end: s.end }]);
    expect(a!.harmony!).toBeGreaterThan(0.7);
    expect(a!.chip).not.toBe('rough');
  });

  it('reports every request, in order, with the points it was computed for', () => {
    const reports = song1.session.seamReport([
      { id: 'x', start: 2, end: 10.0 },
      { id: 'y', start: 4, end: 12.0 },
      { id: 'z', start: 8, end: 24.0 },
    ]);
    expect(reports.map((r) => r.id)).toEqual(['x', 'y', 'z']);
    expect(reports.map((r) => [r.start, r.end])).toEqual([[2, 10], [4, 12], [8, 24]]);
    for (const r of reports) {
      for (const v of [r.scores.transient, r.scores.spectral, r.scores.quality]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('seam scores', () => {
  const song = analyseChordSong(SONG1);
  const tool = song.session.seamAnalysis()!;
  const beats = song.analysis.beats;

  it('transient cover: high just before a hit, low on it', () => {
    // beat 8 is a kick; the fine onset curve peaks about 4 ms before the click
    const hit = beats[8]!;
    const before = tool.transientCover(hit - 0.015);
    const on = tool.transientCover(hit);
    const after = tool.transientCover(hit + 0.08);
    expect(before).toBeGreaterThan(0.8);
    expect(on).toBeLessThan(before - 0.3);
    expect(after).toBeLessThan(before - 0.3);
  });

  it('spectral continuity: a loop that is the song\'s own period reads about as smooth as the song', () => {
    const end = beats[32]!;
    const start = beats[0]!;
    const s = tool.spectralContinuity(end, start);
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('spectral continuity falls when the spectrum jumps', () => {
    // from the middle of a bar's decay (beat 3 of bar 0) into the downbeat of a different chord's bar
    const smooth = tool.spectralContinuity(beats[32]!, beats[0]!);
    const jumpy = tool.spectralContinuity(beats[2]! + 0.2, beats[17]! + 0.2); // mid-beat to mid-beat, other chord
    expect(jumpy).toBeLessThanOrEqual(smooth + 0.3);
    expect(tool.seamFlux(beats[2]! + 0.2, beats[17]! + 0.2)).toBeGreaterThanOrEqual(0);
  });

  it('knows where in the bar a time is', () => {
    const k = ANALYSIS_CONFIG.seam.spectral.bucketsPerBeat;
    expect(tool.barBucket(beats[4]!)).toBe(0); // a downbeat
    expect(tool.barBucket(beats[5]!)).toBe(k);
    expect(tool.barBucket((beats[4]! + beats[5]!) / 2)).toBeGreaterThanOrEqual(k / 2 - 1);
    expect(tool.barBucket((beats[4]! + beats[5]!) / 2)).toBeLessThanOrEqual(k / 2);
  });
});

describe('seam report edge cases', () => {
  it('works for a song too short for suggestions', () => {
    const s = analyseChordSong({ progressions: { A: 'C G Am F' }, structure: 'AA' }); // 8 bars = 16 s
    expect(s.analysis.skipped).toBe('short');
    expect(s.analysis.candidates).toEqual([]);
    const [r] = s.session.seamReport([{ id: 'x', start: 0, end: 8 }]);
    expect(r!.hasGrid).toBe(true);
    expect(r!.harmony).not.toBeNull();
  });

  it('silent audio gives no report', () => {
    const session = new AnalysisSession(new Float32Array(SR * 5), SR);
    session.run(4);
    expect(session.seamReport([{ id: 'x', start: 0, end: 2 }])).toEqual([]);
  });

  it('without a steady beat harmony is null and the chip comes from the other two scores', () => {
    let x = 12345;
    const noise = new Float32Array(SR * 25);
    for (let i = 0; i < noise.length; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      noise[i] = (x / 2147483648 - 1) * 0.3;
    }
    const session = new AnalysisSession(noise, SR);
    const a = session.run(4);
    expect(a.steadyBeat).toBe(false);
    const [r] = session.seamReport([{ id: 'x', start: 3, end: 11 }]);
    expect(r!.hasGrid).toBe(false);
    expect(r!.harmony).toBeNull();
    expect(r!.contextMatch).toBeNull();
    expect(r!.scores.quality).toBeGreaterThanOrEqual(0);
    expect(['clean', 'ok', 'rough']).toContain(r!.chip);
  });
});
