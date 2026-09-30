import { describe, expect, it } from 'vitest';
import { barBeatIndices, pickBarPhase } from '../../src/analysis/bars';
import { AnalysisSession, analyzeSignal } from '../../src/analysis/pipeline';
import { synthSong } from '../fixtures/synth';

const SR = 22050;

function barTimesOf(a: { beats: number[]; barPhase: number; beatsPerBar: number }): number[] {
  return barBeatIndices(a.beats.length, a.barPhase, a.beatsPerBar).map((i) => a.beats[i]!);
}

/** Fraction of detected bar lines that lie within `tol` of a true bar line. */
function barAccuracy(trueBars: number[], detected: number[], tol: number): number {
  let ok = 0;
  for (const d of detected) if (trueBars.some((t) => Math.abs(t - d) <= tol)) ok++;
  return detected.length ? ok / detected.length : 0;
}

describe('bar phase', () => {
  it('picks the phase with the strongest evidence', () => {
    const evidence = Float64Array.from([0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0]);
    expect(pickBarPhase(evidence, 4).phase).toBe(2);
    expect(barBeatIndices(12, 2, 4)).toEqual([2, 6, 10]);
  });

  it('finds the downbeats of the synthetic song (4/4)', () => {
    const song = synthSong({ sampleRate: SR });
    const a = analyzeSignal(song.samples, SR, 4);
    expect(a.beatsPerBar).toBe(4);
    expect(barAccuracy(song.barTimes, barTimesOf(a), 0.05)).toBeGreaterThanOrEqual(0.9);
  });

  it('finds downbeats when the song starts late', () => {
    const song = synthSong({ sampleRate: SR, leadIn: 1.3, structure: 'ABAB' });
    const a = analyzeSignal(song.samples, SR, 4);
    expect(barAccuracy(song.barTimes, barTimesOf(a), 0.05)).toBeGreaterThanOrEqual(0.9);
  });

  it('finds downbeats in 3/4', () => {
    const song = synthSong({ sampleRate: SR, beatsPerBar: 3, bpm: 110, structure: 'ABAB', barsPerSection: 4 });
    const a = analyzeSignal(song.samples, SR, 3);
    expect(a.beatsPerBar).toBe(3);
    expect(barAccuracy(song.barTimes, barTimesOf(a), 0.05)).toBeGreaterThanOrEqual(0.9);
  });

  it('re-runs only the bar stage for beatsPerBar changes and nudges the phase', () => {
    const song = synthSong({ sampleRate: SR, structure: 'ABAB' });
    const session = new AnalysisSession(song.samples, SR);
    const a4 = session.run(4);
    const beatsBefore = a4.beats.slice();
    const a3 = session.update({ beatsPerBar: 3 });
    expect(a3.beatsPerBar).toBe(3);
    expect(a3.beats).toEqual(beatsBefore); // beats cached, not recomputed
    const back = session.update({ beatsPerBar: 4 });
    expect(back.barPhase).toBe(a4.barPhase);
    const shifted = session.update({ phaseShift: 1 });
    expect(shifted.barPhase).toBe((a4.barPhase + 1) % 4);
    const shiftedBack = session.update({ phaseShift: -1 });
    expect(shiftedBack.barPhase).toBe(a4.barPhase);
    const wrap = session.update({ phaseShift: -1 });
    expect(wrap.barPhase).toBe((a4.barPhase + 3) % 4);
  });
});
