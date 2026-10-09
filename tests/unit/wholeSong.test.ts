import { describe, expect, it } from 'vitest';
import { barBeatIndices } from '../../src/analysis/bars';
import { ANALYSIS_CONFIG } from '../../src/analysis/config';
import { AnalysisSession, analyzeSignal } from '../../src/analysis/pipeline';
import { findWholeSongLoops } from '../../src/analysis/wholeSong';
import { chordSong, sine, synthSong } from '../fixtures/synth';
import type { ChordSongOptions } from '../fixtures/synth';

// SPEC-v1.4.md 2 and 4: the whole-song loop search.

const SR = 22050;
const cfg = ANALYSIS_CONFIG.wholeSong;

/**
 * An 8-bar intro (its own chords, soft sine tones), the body A B A B C A (C holds the F -> C change that the jump from
 * the end of the body back to its start needs), and a 4-bar outro whose chords differ from the intro's.
 */
const INTRO_BODY_OUTRO: ChordSongOptions = {
  progressions: { I: 'E B C#m A E B C#m A', A: 'C G Am F', B: 'Dm Em F G', C: 'Am F C G', O: 'Ab Fm Db Eb' },
  structure: 'IABABCAO',
  timbre: { I: 'sine', O: 'square' },
  hats: { A: true, B: true, C: true },
};
const INTRO_END = 16;
const OUTRO_START = 64;
const BAR = 2;

describe('findWholeSongLoops on an intro, a body and an outro', () => {
  const song = chordSong(INTRO_BODY_OUTRO);
  const session = new AnalysisSession(song.samples, song.sampleRate);
  const analysis = session.run(song.beatsPerBar);
  const options = analysis.wholeSong;

  it('puts the start at the end of the intro and the end at the start of the outro, within a bar', () => {
    expect(song.sections[0]!.end).toBe(INTRO_END);
    expect(song.sections[7]!.start).toBe(OUTRO_START);
    const top = options[0]!;
    expect(top).toBeDefined();
    expect(Math.abs(top.start - INTRO_END)).toBeLessThanOrEqual(BAR);
    expect(Math.abs(top.end - OUTRO_START)).toBeLessThanOrEqual(BAR);
  });

  it('keeps at least 60% of the song and every option is bar-aligned', () => {
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options.length).toBeLessThanOrEqual(cfg.maxOptions);
    const bars = new Set(session.barBeats());
    for (const o of options) {
      expect(bars.has(o.startBeat)).toBe(true);
      expect(bars.has(o.endBeat)).toBe(true);
      expect((o.endBeat - o.startBeat) % analysis.beatsPerBar).toBe(0);
      expect(o.bars).toBe((o.endBeat - o.startBeat) / analysis.beatsPerBar);
      expect(o.start).toBe(analysis.beats[o.startBeat]);
      expect(o.end).toBe(analysis.beats[o.endBeat]);
      expect((o.end - o.start) / analysis.duration).toBeGreaterThanOrEqual(cfg.minCoverage);
      expect(o.components.coverage).toBeCloseTo((o.end - o.start) / analysis.duration, 9);
    }
  });

  it('starts and ends inside the search windows', () => {
    const startWindow = Math.min(cfg.startWindowFraction * analysis.duration, cfg.startWindowSeconds);
    const endWindow = Math.min(cfg.endWindowFraction * analysis.duration, cfg.endWindowSeconds);
    for (const o of options) {
      expect(o.start).toBeLessThanOrEqual(startWindow);
      expect(o.end).toBeGreaterThanOrEqual(analysis.duration - endWindow);
    }
  });

  it('returns them best first, with the score made of its parts, and reports what each repeat skips', () => {
    for (let i = 1; i < options.length; i++) expect(options[i - 1]!.score).toBeGreaterThanOrEqual(options[i]!.score);
    for (const o of options) {
      const c = o.components;
      const w = cfg.weights;
      expect(o.score).toBeCloseTo(w.seam * c.seam + w.structure * c.structure + w.energy * c.energy + w.coverage * c.coverage, 9);
      for (const v of [c.seam, c.structure, c.energy, c.coverage, c.contextMatch, c.harmony ?? 0]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(o.skipsIntro).toBeCloseTo(o.start, 9);
      expect(o.skipsOutro).toBeCloseTo(analysis.duration - o.end, 9);
      expect(o.stars).toBeGreaterThanOrEqual(1);
      expect(o.stars).toBeLessThanOrEqual(5);
      expect(o.reason).toMatch(/keeps \d+% of the song/);
    }
  });

  it('uses the chord change the song makes: the top option leads back cleanly', () => {
    const top = options[0]!;
    expect(top.components.harmony).toBeGreaterThanOrEqual(ANALYSIS_CONFIG.harmony.good);
    expect(top.reason).toContain('Chords lead back cleanly');
  });

  it('keeps no two options within 2 bars of each other at both edges', () => {
    const near = cfg.nmsBars * analysis.beatsPerBar;
    for (let i = 0; i < options.length; i++) {
      for (let j = i + 1; j < options.length; j++) {
        const close = Math.abs(options[i]!.startBeat - options[j]!.startBeat) <= near && Math.abs(options[i]!.endBeat - options[j]!.endBeat) <= near;
        expect(close).toBe(false);
      }
    }
  });

  it('follows the bar line when the user shifts it', () => {
    const shifted = new AnalysisSession(song.samples, song.sampleRate);
    shifted.run(song.beatsPerBar);
    const a = shifted.update({ phaseShift: 1 });
    const bars = new Set(shifted.barBeats());
    for (const o of a.wholeSong) expect(bars.has(o.startBeat) && bars.has(o.endBeat)).toBe(true);
  });
});

describe('findWholeSongLoops: nothing to offer', () => {
  it('is empty for a song under 20 seconds', () => {
    const short = chordSong({ progressions: { A: 'C G Am F', B: 'Dm Em F G' }, structure: 'AB' }); // 16 s
    expect(short.duration).toBeLessThan(ANALYSIS_CONFIG.limits.minSongSeconds);
    const a = analyzeSignal(short.samples, short.sampleRate, 4);
    expect(a.wholeSong).toEqual([]);
    expect(a.skipped).toBe('short');
  });

  it('is empty for a song with no steady beat', () => {
    const tone = sine(220, 40, SR, 0.4);
    const a = analyzeSignal(tone, SR, 4);
    expect(a.steadyBeat).toBe(false);
    expect(a.wholeSong).toEqual([]);
  });

  it('is empty for silence', () => {
    const a = analyzeSignal(new Float32Array(SR * 30), SR, 4);
    expect(a.wholeSong).toEqual([]);
  });

  it('is empty when asked about a song without a steady beat directly', () => {
    const song = chordSong(INTRO_BODY_OUTRO);
    const session = new AnalysisSession(song.samples, song.sampleRate);
    session.run(4);
    const out = findWholeSongLoops({
      ssm: session.similarity!,
      features: session.beatFeatures!,
      beats: song.beatTimes,
      barBeats: barBeatIndices(song.beatTimes.length, 0, 4),
      beatsPerBar: 4,
      sections: [],
      boundaries: [],
      duration: song.duration,
      steadyBeat: false,
    });
    expect(out).toEqual([]);
  });
});

describe('findWholeSongLoops: time', () => {
  it('a five-minute song stays under the 5 s analysis budget with the search in it', () => {
    const song = synthSong({ sampleRate: SR, structure: 'ABABCA'.repeat(6) });
    expect(song.duration).toBeGreaterThan(280);
    const t0 = performance.now();
    const a = analyzeSignal(song.samples, SR, 4);
    const seconds = (performance.now() - t0) / 1000;
    expect(a.wholeSong.length).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(5);
  });

  it('a fast five-minute song (many bars in the windows) too', () => {
    const song = synthSong({ sampleRate: SR, structure: 'ABABCA'.repeat(12), bpm: 190, barsPerSection: 4 });
    expect(song.duration).toBeGreaterThan(280);
    const t0 = performance.now();
    const a = analyzeSignal(song.samples, SR, 4);
    const seconds = (performance.now() - t0) / 1000;
    expect(a.wholeSong.length).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(5);
  });
});
