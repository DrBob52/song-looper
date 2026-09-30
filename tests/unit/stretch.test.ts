import { describe, expect, it } from 'vitest';
import { isNeutral, stretchChannels, stretchedLength } from '../../src/audio/stretch';
import { sine } from '../fixtures/synth';

const SR = 44100;

/** Estimate the frequency of a tone from zero crossings in the middle half of the signal. */
function frequency(x: Float32Array, sr: number): number {
  const a = Math.floor(x.length * 0.25);
  const b = Math.floor(x.length * 0.75);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1]! <= 0 && x[i]! > 0) crossings++;
  return crossings / ((b - a) / sr);
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

describe('stretchChannels (SoundTouch)', () => {
  const tone = sine(440, 3, SR, 0.5);

  it('reports neutrality and output length', () => {
    expect(isNeutral(null)).toBe(true);
    expect(isNeutral({ tempo: 1, pitchSemitones: 0 })).toBe(true);
    expect(isNeutral({ tempo: 1.1, pitchSemitones: 0 })).toBe(false);
    expect(isNeutral({ tempo: 1, pitchSemitones: -2 })).toBe(false);
    expect(stretchedLength(44100, 1.25)).toBe(35280);
  });

  it('speeds up without changing pitch', () => {
    const [out] = stretchChannels([tone], SR, { tempo: 1.25, pitchSemitones: 0 });
    expect(out!.length).toBe(stretchedLength(tone.length, 1.25));
    expect(Math.abs(frequency(out!, SR) - 440)).toBeLessThan(6);
    expect(rms(out!, 20000, 60000)).toBeGreaterThan(0.25);
  });

  it('slows down without changing pitch', () => {
    const [out] = stretchChannels([tone], SR, { tempo: 0.6, pitchSemitones: 0 });
    expect(out!.length).toBe(stretchedLength(tone.length, 0.6));
    expect(Math.abs(frequency(out!, SR) - 440)).toBeLessThan(6);
  });

  it('shifts pitch without changing length', () => {
    const up = stretchChannels([tone], SR, { tempo: 1, pitchSemitones: 12 })[0]!;
    expect(up.length).toBe(tone.length);
    expect(Math.abs(frequency(up, SR) - 880)).toBeLessThan(12);
    const down = stretchChannels([tone], SR, { tempo: 1, pitchSemitones: -5 })[0]!;
    expect(Math.abs(frequency(down, SR) - 440 * Math.pow(2, -5 / 12))).toBeLessThan(6);
  });

  it('combines speed and pitch', () => {
    const [out] = stretchChannels([tone], SR, { tempo: 0.8, pitchSemitones: 7 });
    expect(out!.length).toBe(stretchedLength(tone.length, 0.8));
    expect(Math.abs(frequency(out!, SR) - 440 * Math.pow(2, 7 / 12))).toBeLessThan(12);
  });

  it('keeps channels independent and handles mono, stereo and three channels', () => {
    const a = sine(300, 1.5, SR, 0.4);
    const b = sine(600, 1.5, SR, 0.4);
    const stereo = stretchChannels([a, b], SR, { tempo: 1.2, pitchSemitones: 0 });
    expect(stereo).toHaveLength(2);
    expect(stereo[0]!.length).toBe(stereo[1]!.length);
    expect(Math.abs(frequency(stereo[0]!, SR) - 300)).toBeLessThan(6);
    expect(Math.abs(frequency(stereo[1]!, SR) - 600)).toBeLessThan(10);
    expect(stretchChannels([a], SR, { tempo: 1.2, pitchSemitones: 0 })).toHaveLength(1);
    expect(stretchChannels([a, b, a], SR, { tempo: 1.2, pitchSemitones: 0 })).toHaveLength(3);
  });

  it('reports progress up to 1', () => {
    const seen: number[] = [];
    stretchChannels([sine(440, 1, SR)], SR, { tempo: 1.1, pitchSemitones: 1 }, (f) => seen.push(f));
    expect(seen[seen.length - 1]).toBe(1);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  });
});
