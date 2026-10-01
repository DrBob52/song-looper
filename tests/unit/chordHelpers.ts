import { AnalysisSession } from '../../src/analysis/pipeline';
import type { Analysis } from '../../src/analysis/types';
import { nearestIndex } from '../../src/grid';
import { chordSong } from '../fixtures/synth';
import type { ChordSong, ChordSongOptions } from '../fixtures/synth';

export interface AnalysedChordSong {
  song: ChordSong;
  session: AnalysisSession;
  analysis: Analysis;
  /** Beat index nearest to a time in seconds. */
  beat(t: number): number;
  /** Beat range [a, b) of the n-th section (or sections i..j). */
  span(i: number, j?: number): [number, number];
}

/** Synthesise a chord-progression song and run the analysis session on it. */
export function analyseChordSong(options: Pick<ChordSongOptions, 'progressions' | 'structure'> & Partial<ChordSongOptions>): AnalysedChordSong {
  const song = chordSong(options);
  const session = new AnalysisSession(song.samples, song.sampleRate);
  const analysis = session.run(song.beatsPerBar);
  const beat = (t: number): number => nearestIndex(analysis.beats, t);
  return {
    song,
    session,
    analysis,
    beat,
    span: (i, j = i) => [beat(song.sections[i]!.start), beat(song.sections[j]!.end)],
  };
}
