import { describe, expect, it } from 'vitest';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import { AnalysisSession } from '../../src/analysis/pipeline';
import { alignEnd, chooseFade, onsetAround } from '../../src/analysis/smooth';
import { renderSeamSnippet } from '../../src/audio/preview';
import { renderExtended } from '../../src/audio/render';
import { makeBuffer } from '../../src/audio/types';
import type { SeamPlan } from '../../src/model';
import { SONG1, clickTrack, drumSong } from '../fixtures/synth';
import { analyseChordSong } from './chordHelpers';

const SR = 22050;
const beatOf = 0.5; // 120 BPM

function dummyScores(): SeamPlan['before'] {
  return { transient: 0, spectral: 0, harmony: null, quality: 0 };
}

/** A hand-made plan for a plain loop: only the end edge moved and the fade set. */
function planFor(start: number, end: number, align: number, fadeMs: number, levelDb = 0, rampSeconds = 0.5): SeamPlan {
  const to = start;
  const from = end + align;
  return {
    forStart: start,
    forEnd: end,
    smooth: true,
    shift: 0,
    align,
    loopStart: start,
    loopEnd: from,
    jumps: [{ from, to, fadeMs, ...(levelDb ? { levelDb, rampSeconds } : {}) }],
    before: dummyScores(),
    after: dummyScores(),
    bridge: null,
  };
}

describe('rotation (SPEC-seams.md 3.1)', () => {
  const ds = drumSong({ seconds: 60, sampleRate: SR });
  const session = new AnalysisSession(ds.samples, SR);
  const analysis = session.run(4);
  const hitAfter = (t: number): number => ds.hitTimes.find((h) => h >= t - 1e-9)!;

  it('tracks the drum song at 120 BPM', () => {
    expect(Math.abs(analysis.bpm - 120)).toBeLessThan(1);
  });

  it('keeps the loop length exactly and moves by at most one beat', () => {
    for (const off of [0.012, 0.2, 0.31, 0.45, -0.1]) {
      const start = ds.hitTimes[11]! + off;
      const end = start + 8;
      const [r] = session.seamReport([{ id: 'x', start, end }]);
      const p = r!.plan!;
      expect(Math.abs(p.shift)).toBeLessThanOrEqual(beatOf + 1e-9);
      // rotation moves both edges by the same amount: the length is exactly unchanged
      expect(p.loopEnd - p.align - p.loopStart).toBeCloseTo(end - start, 9);
      expect(p.loopStart).toBeCloseTo(start + p.shift, 9);
    }
  });

  it('moves a seam that sits just after a snare hit to just before the next hit', () => {
    const snare = ds.snareTimes[5]!;
    for (const after of [0.012, 0.02]) {
      const start = snare + after; // just after the snare
      const [r] = session.seamReport([{ id: 'x', start, end: start + 8 }]);
      const seam = start + r!.plan!.shift;
      const ahead = hitAfter(seam) - seam;
      // right before a hit: the next hit is a few ms to a few tens of ms away
      expect(ahead).toBeGreaterThanOrEqual(0.004);
      expect(ahead).toBeLessThanOrEqual(0.04);
      expect(r!.plan!.after.transient).toBeGreaterThan(r!.plan!.before.transient + 0.3);
    }
  });

  it('leaves a seam alone that already sits right before a hit', () => {
    const start = ds.hitTimes[9]! - 0.02;
    const [r] = session.seamReport([{ id: 'x', start, end: start + 8 }]);
    expect(Math.abs(r!.plan!.shift)).toBeLessThanOrEqual(0.01);
  });

  it('stays inside the free space it is given', () => {
    const start = ds.snareTimes[5]! + 0.012;
    const [r] = session.seamReport([{ id: 'x', start, end: start + 8, minStart: start - 0.005, maxEnd: start + 8.005 }]);
    expect(r!.plan!.shift).toBeGreaterThanOrEqual(-0.005 - 1e-9);
    expect(r!.plan!.loopEnd).toBeLessThanOrEqual(start + 8.005 + 1e-9);
    expect(r!.plan!.loopStart).toBeGreaterThanOrEqual(start - 0.005 - 1e-9);
  });

  it('does nothing when smoothing is off', () => {
    const start = ds.snareTimes[5]! + 0.012;
    const [r] = session.seamReport([{ id: 'x', start, end: start + 8, smooth: false }]);
    expect(r!.plan).toBeNull();
    expect(r!.scores).toEqual(r!.before);
  });
});

describe('micro-alignment (SPEC-seams.md 3.2)', () => {
  const ct = clickTrack(120, 30, SR, 0.5); // a click on every half second, exactly
  const start = 4.5;

  it('recovers an end edge that is 15 ms late, within 2 ms', () => {
    const a = alignEnd(ct.samples, SR, start, 12.5 + 0.015);
    expect(a.method).toBe('onset');
    expect(Math.abs(a.align + 0.015)).toBeLessThan(0.002);
  });

  it('recovers early edges and small offsets, and leaves aligned edges alone', () => {
    for (const off of [-0.015, 0.008, -0.004, 0.003]) {
      const a = alignEnd(ct.samples, SR, start, 12.5 + off);
      expect(Math.abs(a.align + off)).toBeLessThan(0.002);
    }
    expect(alignEnd(ct.samples, SR, start, 12.5).align).toBe(0);
  });

  it('never moves the end edge by more than 20 ms', () => {
    for (const off of [0.025, -0.03, 0.2]) {
      const a = alignEnd(ct.samples, SR, start, 12.5 + off);
      expect(Math.abs(a.align)).toBeLessThanOrEqual(0.02 + 1e-12);
    }
  });

  it('the rendered seam window then holds one onset, not two', () => {
    const buffer = makeBuffer([ct.samples], SR);
    const end = 12.5 + 0.015;
    const align = alignEnd(ct.samples, SR, start, end).align;
    const countOnsets = (x: Float32Array, centre: number): number => {
      const hop = 16;
      const half = Math.round((0.06 * SR) / hop);
      const curve = onsetAround(x, centre - half * hop, 2 * half + 1, 256, hop);
      const peak = curve.reduce((m, v) => Math.max(m, v), 0);
      let n = 0;
      for (let i = 1; i < curve.length - 1; i++) if (curve[i]! > 0.25 * peak && curve[i]! >= curve[i - 1]! && curve[i]! > curve[i + 1]!) n++;
      return n;
    };
    const raw = renderSeamSnippet(buffer, { start, end, seam: planFor(start, end, 0, 20) });
    const fixed = renderSeamSnippet(buffer, { start, end, seam: planFor(start, end, align, 20) });
    expect(countOnsets(raw.channels[0]!, raw.seamIndex)).toBe(2);
    expect(countOnsets(fixed.channels[0]!, fixed.seamIndex)).toBe(1);
  });

  it('uses the waveform when neither edge has a hit', () => {
    const x = new Float32Array(SR * 20);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 495 * i) / SR + 0.5);
    // the start edge 3 samples (~0.14 ms) from a point where the waveforms line up; the end edge 5 ms off
    const a = alignEnd(x, SR, 4, 10.005);
    expect(a.method).toBe('waveform');
    expect(Math.abs(a.align)).toBeLessThanOrEqual(0.02);
    // after moving, the two sides line up better than before
    expect(a.corr).toBeGreaterThanOrEqual(a.baseCorr);
  });
});

describe('adaptive fade (SPEC-seams.md 3.3)', () => {
  // A jump between two different sustained tones: the longer the fade the smoother the join, as far as the measure sees.
  const x = new Float32Array(SR * 12);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 451 * i) / SR + 1);

  it('offers 10, 20, 40, 80, 160 ms and a beat, and only up to 40 ms when the harmony is poor', () => {
    const good = chooseFade(x, SR, 4.0013, 8.0, 1, 0.5);
    expect(good.tried.map((t) => t.fadeMs)).toEqual([10, 20, 40, 80, 160, 500]);
    const poor = chooseFade(x, SR, 4.0013, 8.0, 0.2, 0.5);
    expect(poor.tried.map((t) => t.fadeMs)).toEqual([10, 20, 40]);
    expect(poor.fadeMs).toBeLessThanOrEqual(40);
    const edge = chooseFade(x, SR, 4.0013, 8.0, 0.499, 0.5);
    expect(edge.fadeMs).toBeLessThanOrEqual(40);
    const fine = chooseFade(x, SR, 4.0013, 8.0, 0.5, 0.5);
    expect(fine.tried.length).toBe(6);
  });

  it('picks a fade that removes the click of a mismatched join', () => {
    const c = chooseFade(x, SR, 4.0013, 8.0, 1, 0.5);
    const first = c.tried[0]!;
    const picked = c.tried.find((t) => t.fadeMs === c.fadeMs)!;
    expect(first.excess).toBeGreaterThan(picked.excess - 1e-9);
    expect(picked.excess).toBeLessThanOrEqual(Math.min(...c.tried.map((t) => t.excess)) * 1.15 + ANALYSIS_CONFIG.seam.fade.floor + 1e-9);
  });

  it('a join that is as smooth as the music takes the shortest fade', () => {
    const c = chooseFade(x, SR, 4.0, 8.0, 1, 0.5);
    expect(c.fadeMs).toBe(10);
  });

  it('with harmony below 0.5 the fade of a real seam is 40 ms or less', () => {
    const song1 = analyseChordSong(SONG1);
    const a = song1.song.sections[0]!; // loop A: harmony ~0
    const [r] = song1.session.seamReport([{ id: 'A', start: a.start, end: a.end }]);
    expect(r!.harmony!).toBeLessThan(0.5);
    expect(r!.plan!.jumps[0]!.fadeMs!).toBeLessThanOrEqual(40);
    for (const s of song1.song.sections) {
      const [q] = song1.session.seamReport([{ id: 'q', start: s.start, end: s.end }]);
      if (q!.harmony! < 0.5) expect(q!.plan!.jumps[0]!.fadeMs!).toBeLessThanOrEqual(40);
    }
  });
});

describe('level match (SPEC-seams.md 3.4)', () => {
  // A pad whose level rises 3 dB across the loop [10, 18] and stays up afterwards.
  const envelopeDb = (t: number): number => (t < 10 ? 0 : t < 18 ? (3 * (t - 10)) / 8 : 3);
  const pad = new Float32Array(SR * 30);
  for (let i = 0; i < pad.length; i++) {
    const t = i / SR;
    const g = 10 ** (envelopeDb(t) / 20);
    pad[i] = g * (0.15 * Math.sin((2 * Math.PI * 261.6 * i) / SR) + 0.12 * Math.sin((2 * Math.PI * 329.6 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 392 * i) / SR));
  }
  const buffer = makeBuffer([pad], SR);
  const session = new AnalysisSession(pad, SR);
  session.run(4);

  const rms = (x: Float32Array, from: number, to: number): number => {
    let s = 0;
    for (let i = from; i < to; i++) s += x[i]! * x[i]!;
    return 10 * Math.log10(s / (to - from));
  };
  const stepAt = (out: Float32Array, seamSeconds: number): number => {
    const k = Math.round(seamSeconds * SR);
    const w = Math.round(0.05 * SR);
    return Math.abs(rms(out, k, k + w) - rms(out, k - w, k));
  };

  it('a 3 dB crescendo loop has a level step of about 3 dB at the seam without it', () => {
    const out = renderExtended(buffer, { regions: [{ id: 'a', start: 10, end: 18, repeats: 3, color: '#000' }] })[0]!;
    expect(stepAt(out, 18)).toBeGreaterThan(2.5);
  });

  it('no level step above 0.5 dB at the seam after smoothing', () => {
    const [r] = session.seamReport([{ id: 'a', start: 10, end: 18 }]);
    const jump = r!.plan!.jumps[0]!;
    expect(jump.levelDb).toBeLessThan(-2);
    expect(jump.levelDb).toBeGreaterThan(-3.5);
    expect(jump.rampSeconds).toBeGreaterThan(0);
    const region = { id: 'a', start: 10, end: 18, repeats: 4, color: '#000', seam: r!.plan! };
    const out = renderExtended(buffer, { regions: [region] })[0]!;
    // the plan may move the end edge a few ms (alignment): look at every seam where it falls
    const loop = r!.plan!.loopEnd - r!.plan!.loopStart;
    for (let k = 1; k <= 3; k++) {
      expect(stepAt(out, r!.plan!.loopStart + k * loop)).toBeLessThan(0.5);
    }
    // the final pass into the rest of the song is untouched: the last repeat plays like the original
    const lastStart = Math.round((r!.plan!.loopStart + 3 * loop) * SR);
    const orig = pad.subarray(Math.round(r!.plan!.loopStart * SR), Math.round(r!.plan!.loopEnd * SR) - 1);
    const tail = out.subarray(lastStart, lastStart + orig.length);
    const mid = Math.round(orig.length / 2);
    expect(Math.abs(rms(tail, mid, mid + 2000) - rms(orig, mid, mid + 2000))).toBeLessThan(0.05);
  });

  it('a natural seam gets no ramp: the song\'s own accent pattern is not a level jump', () => {
    const song = analyseChordSong(SONG1);
    for (const s of song.song.sections) {
      const [r] = song.session.seamReport([{ id: 's', start: s.start, end: s.end }]);
      expect(r!.plan!.jumps[0]!.levelDb).toBeUndefined();
    }
  });
});
