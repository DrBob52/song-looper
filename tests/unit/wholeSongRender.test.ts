import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../../src/analysis/pipeline';
import { extendedDuration, plannedFrames, renderExtended, renderRange } from '../../src/audio/render';
import { makeBuffer } from '../../src/audio/types';
import type { Plan } from '../../src/model';
import { chordSong } from '../fixtures/synth';

// SPEC-v1.4.md 4: a whole-song loop is an ordinary loop that covers almost the whole song. With N plays the extended
// song is D + (N - 1) * (end - start) long, and renderRange equals the same slice of the full render.

const SONG = chordSong({
  progressions: { I: 'E B C#m A E B C#m A', A: 'C G Am F', B: 'Dm Em F G', C: 'Am F C G', O: 'Ab Fm Db Eb' },
  structure: 'IABABCAO',
  timbre: { I: 'sine', O: 'square' },
  hats: { A: true, B: true, C: true },
});
const analysis = new AnalysisSession(SONG.samples, SONG.sampleRate).run(SONG.beatsPerBar);
const option = analysis.wholeSong[0]!;
const buffer = makeBuffer([SONG.samples], SONG.sampleRate);
const D = buffer.length / buffer.sampleRate;

const planOf = (plays: number): Plan => ({
  regions: [{ id: 'w', start: option.start, end: option.end, repeats: plays, color: '#000' }],
});

describe('a whole-song loop with N plays', () => {
  it('is found in the song to start with', () => {
    expect(option).toBeDefined();
    expect(option.end - option.start).toBeGreaterThan(0.6 * D);
  });

  for (const plays of [1, 2, 3, 5]) {
    it(`renders ${plays} play(s) as D + (N - 1) * (end - start)`, () => {
      const plan = planOf(plays);
      const expected = D + (plays - 1) * (option.end - option.start);
      expect(extendedDuration(plan, D)).toBeCloseTo(expected, 9);
      // Without zero-crossing snapping the loop edges sit on the given samples: exact to a frame per play.
      const exact = plannedFrames(buffer, plan, { snapZeroCrossings: false });
      expect(Math.abs(exact - expected * buffer.sampleRate)).toBeLessThanOrEqual(plays);
      // With it each edge may move by up to 2 ms.
      const frames = plannedFrames(buffer, plan);
      const slack = (plays - 1) * Math.ceil(0.004 * buffer.sampleRate) + plays;
      expect(Math.abs(frames - expected * buffer.sampleRate)).toBeLessThanOrEqual(slack);
      const full = renderExtended(buffer, plan);
      expect(full[0]!.length).toBe(frames);
    });
  }

  it('renders the same samples through renderRange as through the full render', () => {
    const plan = planOf(3);
    const full = renderExtended(buffer, plan)[0]!;
    const total = full.length;
    const jump1 = Math.round(option.end * buffer.sampleRate);
    const jump2 = jump1 + Math.round((option.end - option.start) * buffer.sampleRate);
    const ranges: [number, number][] = [
      [0, 5000],
      [jump1 - 300, 600],
      [jump2 - 300, 600],
      [Math.floor(total / 2), 40000],
      [total - 3000, 3000],
      [0, total],
    ];
    for (const [start, length] of ranges) {
      const got = renderRange(buffer, plan, start, length)[0]!;
      const want = full.subarray(start, start + length);
      expect(got.length).toBe(want.length);
      expect(Buffer.from(got.buffer, got.byteOffset, got.byteLength).equals(Buffer.from(want.buffer, want.byteOffset, want.byteLength))).toBe(true);
    }
  });

  it('the first play runs from 0:00 and the last play runs on to the real ending', () => {
    const plan = planOf(2);
    const full = renderExtended(buffer, plan)[0]!;
    const sr = buffer.sampleRate;
    const src = SONG.samples;
    // play 1 is the song untouched up to the jump (well before the crossfade)
    for (let i = 0; i < Math.round((option.end - 0.2) * sr); i += 997) expect(full[i]).toBe(src[i]);
    // the tail after the last play's end is the song's outro, as is
    const tail = Math.round((D - option.end - 0.5) * sr);
    for (let k = 0; k < tail; k += 997) expect(full[full.length - 1 - k]).toBe(src[src.length - 1 - k]);
  });
});
