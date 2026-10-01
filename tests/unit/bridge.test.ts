import { describe, expect, it } from 'vitest';
import { findBridge } from '../../src/analysis/bridge';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import { buildHarmonyModel } from '../../src/analysis/harmony';
import { renderLoopBody, renderSeamSnippet } from '../../src/audio/preview';
import {
  buildTimeline,
  extendedDuration,
  extendedToOriginal,
  originalToExtended,
  regionsToSamples,
  renderExtended,
} from '../../src/audio/render';
import { solveRepeats } from '../../src/audio/target';
import { makeBuffer } from '../../src/audio/types';
import { SONG1, SONG2 } from '../fixtures/synth';
import { analyseChordSong } from './chordHelpers';

const cfg = ANALYSIS_CONFIG.bridge;

describe('bridge search (SPEC-seams.md 5.1)', () => {
  const song1 = analyseChordSong(SONG1);
  const model = song1.session.harmony!;

  it('song 1, loop A: finds a path of 4 bars or less whose jumps all have harmony >= 0.5', () => {
    const [a, b] = song1.span(0);
    const found = findBridge(model, a, b, 4);
    expect(found.directHarmony).toBeLessThan(0.35);
    expect(found.status).toBe('found');
    const path = found.path!;
    expect(path.bars).toBeGreaterThanOrEqual(1);
    expect(path.bars).toBeLessThanOrEqual(4);
    expect(path.jumps.length).toBeGreaterThanOrEqual(1);
    expect(path.jumps.length).toBeLessThanOrEqual(2);
    for (const j of path.jumps) expect(j.harmony).toBeGreaterThanOrEqual(0.5);
    // the last jump lands on the loop's first beat
    expect(path.jumps[path.jumps.length - 1]!.to).toBe(a);
    // it beats the direct seam by at least 0.2
    expect(path.worstHarmony).toBeGreaterThanOrEqual(found.directHarmony + cfg.minGain);
  });

  it('finds the obvious candidate: carry on into the song, then jump back at the bar line where the chord change occurs', () => {
    const [a, b] = song1.span(0);
    const path = findBridge(model, a, b, 4).path!;
    // the song after A is B (Dm Em F G); G -> C is in the song (end of B back into A), so the path plays all of B and jumps back
    expect(path.jumps).toHaveLength(1);
    expect(path.runBeats).toBe(path.beats);
    expect(path.jumps[0]!.from).toBe(b - 1 + path.beats);
    expect(path.bars).toBe(4);
    // the song makes that change at the start of its second A: the beat where the evidence is
    expect(path.jumps[0]!.at).toBe(song1.beat(song1.song.sections[2]!.start));
  });

  it('every jump keeps bar structure: it lands on the same bar position as the beat it replaces', () => {
    for (const [from, to] of [[0, 0], [0, 1], [1, 3]] as const) {
      const [a, b] = song1.span(from, to);
      const found = findBridge(model, a + 0, b - (to === 3 ? 2 : 0), 4);
      if (!found.path) continue;
      for (const j of found.path.jumps) expect(((j.to - (j.from + 1)) % 4 + 4) % 4).toBe(0);
      // and what is played beyond the loop completes whole bars
      expect((b - (to === 3 ? 2 : 0) - a + found.path.beats) % 4).toBe(0);
    }
  });

  it('is not offered when the seam is already natural', () => {
    const [a, b] = song1.span(0, 1); // A+B: G -> C is in the song
    const r = findBridge(model, a, b, 4);
    expect(r.directHarmony).toBeGreaterThan(0.8);
    expect(r.status).toBe('unneeded');
    expect(r.path).toBeNull();
  });

  it('a bridge for a loop that is not a whole number of bars completes the last bar', () => {
    const a = 0;
    const b = song1.beat(14); // 7 bars
    const r = findBridge(model, a, b, 4);
    expect(r.status).toBe('found');
    expect((b - a + r.path!.beats) % 4).toBe(0);
    expect(r.path!.beats).toBeGreaterThanOrEqual(4);
  });

  it('respects the limits: at most N jumps and M bars', () => {
    const [a, b] = song1.span(0);
    const oneBar = findBridge(model, a, b, 4, { ...cfg, maxBars: 1 });
    expect(oneBar.path === null || oneBar.path.bars <= 1).toBe(true);
    const one = findBridge(model, a, b, 4, { ...cfg, maxJumps: 1 });
    expect(one.path === null || one.path.jumps.length === 1).toBe(true);
  });

  it('with song 2 (C A B A B) loop B has a bridge, loop A (harmony 1) needs none', () => {
    const song2 = analyseChordSong(SONG2);
    const m2 = song2.session.harmony!;
    const [a, b] = song2.span(1); // A
    expect(findBridge(m2, a, b, 4).status).toBe('unneeded');
    const [c, d] = song2.span(2); // B: G -> Dm is not in the song
    const r = findBridge(m2, c, d, 4);
    expect(r.directHarmony).toBeLessThan(0.5);
    expect(['found', 'none']).toContain(r.status);
    if (r.path) for (const j of r.path.jumps) expect(j.harmony).toBeGreaterThanOrEqual(0.5);
  });

  describe('two jumps, when one is not enough', () => {
    // bars of 4 beats, one label each: A B C D C E F A C E F A. Loop = A B (bars 0-1); B -> A never occurs.
    // One jump back to A would have to wait until the end of F at bar 6: five bars out. Two jumps: C -> E (as at
    // bars 8-9), play E F, then F -> A (as at bars 6-7).
    const bars = 'ABCDCEFACEFA';
    const n = bars.length * 4;
    const C = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) C[i * n + j] = bars[i >> 2] === bars[j >> 2] ? 1 : 0.1;
    const m = buildHarmonyModel({ C, n }, 4, { ...ANALYSIS_CONFIG.harmony, sampleCount: 400 });

    it('finds a path with two jumps, within 4 bars', () => {
      const r = findBridge(m, 0, 8, 4);
      expect(r.directHarmony).toBeLessThan(0.3);
      expect(r.status).toBe('found');
      const p = r.path!;
      expect(p.jumps).toHaveLength(2);
      expect(p.bars).toBeGreaterThanOrEqual(1);
      expect(p.bars).toBeLessThanOrEqual(4);
      // it runs on from the loop end, then leaves the song's own continuation for the E, and comes back from the F
      expect(p.jumps[0]!.from).toBeGreaterThanOrEqual(7);
      expect(p.jumps[0]!.to).not.toBe(p.jumps[0]!.from + 1);
      expect(p.jumps[1]!.to).toBe(0); // the last jump lands on the loop start
      for (const j of p.jumps) {
        expect(j.harmony).toBeGreaterThanOrEqual(0.5);
        expect((((j.to - (j.from + 1)) % 4) + 4) % 4).toBe(0); // bar position preserved
      }
      // the second jump leaves from where the first one landed, after the beats left to play
      expect(p.jumps[1]!.from - p.jumps[0]!.to + 1 + (p.jumps[0]!.from - 7)).toBe(p.beats);
      expect(p.runBeats).toBe(p.jumps[0]!.from - 7);
    });

    it('and not when only one jump is allowed', () => {
      expect(findBridge(m, 0, 8, 4, { ...cfg, maxJumps: 1 }).status).toBe('none');
    });
  });
});

describe('bridge plans, timeline, render length and the target solver (SPEC-seams.md 5.2)', () => {
  const song1 = analyseChordSong(SONG1);
  const A = song1.song.sections[0]!;
  const sr = song1.song.sampleRate;
  const buffer = makeBuffer([song1.song.samples], sr);
  const [report] = song1.session.seamReport([{ id: 'x', start: A.start, end: A.end, bridge: true }]);
  const plan = report!.plan!;
  const region = (repeats: number) => ({ id: 'x', start: A.start, end: A.end, repeats, color: '#000', bridge: true, seam: plan });
  const duration = buffer.duration;

  it('the report finds the bridge and the chip improves', () => {
    expect(report!.bridge).toBe('found');
    expect(plan.bridge).toBeTruthy();
    expect(plan.bridge!.bars).toBe(4);
    expect(plan.bridge!.seconds).toBeCloseTo(8, 1);
    expect(plan.bridge!.worstHarmony).toBeGreaterThanOrEqual(0.5);
    expect(plan.bridge!.chordChangeAt).toBeCloseTo(16, 1); // the song's own G -> C
    expect(report!.before.quality).toBeLessThan(ANALYSIS_CONFIG.seam.chip.ok);
    expect(report!.chip).not.toBe('rough');
    expect(report!.scores.quality).toBeGreaterThan(report!.before.quality + 0.3);
  });

  it('the timeline and the extended length include the bridge: D + (repeats - 1) * (loop + bridge)', () => {
    const repeats = 4;
    const loop = plan.loopEnd - plan.loopStart;
    const bridge = plan.bridge!.seconds;
    const expected = duration + (repeats - 1) * (loop + bridge);
    expect(extendedDuration({ regions: [region(repeats)] }, duration)).toBeCloseTo(expected, 9);
    const tl = buildTimeline({ regions: [region(repeats)] }, duration);
    expect(tl[tl.length - 1]!.outEnd).toBeCloseTo(expected, 9);
    // repeat, bridge, repeat, bridge, repeat, bridge, repeat: the last repeat has no bridge
    const kinds = tl.filter((s) => s.kind !== 'original').map((s) => s.kind);
    expect(kinds).toEqual(['repeat', 'bridge', 'repeat', 'bridge', 'repeat', 'bridge', 'repeat']);
    // no gaps in the output
    for (let i = 1; i < tl.length; i++) expect(tl[i]!.outStart).toBeCloseTo(tl[i - 1]!.outEnd, 9);
    // a bridge plays the song after the loop end (bar by bar)
    const bridges = tl.filter((s) => s.kind === 'bridge');
    expect(bridges.length).toBe(3);
    expect(bridges[0]!.start).toBeCloseTo(plan.loopEnd, 9);
    // the extended cursor maps into the bridge's source
    expect(extendedToOriginal(tl, bridges[0]!.outStart + 1).time).toBeCloseTo(bridges[0]!.start + 1, 9);
    // original -> extended is for the first play: bridges are skipped
    expect(originalToExtended(tl, A.end + 1)).toBeCloseTo(tl[tl.length - 1]!.outEnd - (duration - (A.end + 1)), 6);
  });

  it('the render has exactly that length (up to the zero-crossing snaps)', () => {
    for (const repeats of [1, 2, 3, 5]) {
      const out = renderExtended(buffer, { regions: [region(repeats)] });
      const expected = extendedDuration({ regions: [region(repeats)] }, duration) * sr;
      expect(Math.abs(out[0]!.length - expected)).toBeLessThan(repeats * 0.012 * sr);
    }
    const samples = regionsToSamples(buffer, { regions: [region(3)] })[0]!;
    expect(samples.pieces.length).toBe(plan.jumps.length);
    expect(out0(samples)).toBeGreaterThan(0);
    function out0(r: typeof samples): number {
      return r.pieces.reduce((s, p) => s + p.end - p.start, 0) - (r.end - r.start);
    }
  });

  it('with the bridge off the same loop is the plain loop', () => {
    const plain = { id: 'x', start: A.start, end: A.end, repeats: 3, color: '#000' };
    expect(extendedDuration({ regions: [plain] }, duration)).toBeCloseTo(duration + 2 * (A.end - A.start), 9);
    expect(buildTimeline({ regions: [plain] }, duration).some((s) => s.kind === 'bridge')).toBe(false);
  });

  it('the target solver counts the bridge', () => {
    const regions = [{ start: A.start, end: A.end }];
    const without = solveRepeats(regions, duration, 120);
    const loop = A.end - A.start;
    const withBridge = solveRepeats([{ ...regions[0]!, extra: plan.bridge!.seconds }], duration, 120);
    expect(withBridge.repeats[0]!).toBeLessThan(without.repeats[0]!);
    expect(withBridge.total).toBeCloseTo(duration + (withBridge.repeats[0]! - 1) * (loop + plan.bridge!.seconds), 9);
    // and within half a (loop + bridge) of the target
    expect(Math.abs(withBridge.total - 120)).toBeLessThanOrEqual((loop + plan.bridge!.seconds) / 2 + 1e-9);
  });

  it('seam audition and loop preview agree with the export, bridge included', () => {
    const repeats = 4;
    const full = renderExtended(buffer, { regions: [region(repeats)] })[0]!;
    const s = regionsToSamples(buffer, { regions: [region(repeats)] })[0]!;
    const period = s.pieces.reduce((sum, p) => sum + p.end - p.start, 0);
    const body = renderLoopBody(buffer, { start: A.start, end: A.end, seam: plan });
    expect(body.channels[0]!.length).toBe(period);
    // the export's second and third cycles are the loop body
    expect(Array.from(body.channels[0]!)).toEqual(Array.from(full.subarray(s.start + period, s.start + 2 * period)));
    expect(Array.from(body.channels[0]!)).toEqual(Array.from(full.subarray(s.start + 2 * period, s.start + 3 * period)));
    // the audition: lead-in to the loop end, the bridge, the jump back, the start of the loop again
    const snip = renderSeamSnippet(buffer, { start: A.start, end: A.end, seam: plan });
    const at = snip.seamIndex;
    // the jump back to the start is in the export at the end of the first cycle
    const exportSeam = s.start + period;
    const tail = snip.channels[0]!.length - at;
    expect(Array.from(snip.channels[0]!.subarray(at - 1000, at + Math.min(tail, 4000)))).toEqual(
      Array.from(full.subarray(exportSeam - 1000, exportSeam + Math.min(tail, 4000))),
    );
    // and the audition's map walks from the loop through the bridge back to the start
    expect(snip.map.length).toBe(plan.jumps.length + 1);
  });
});
