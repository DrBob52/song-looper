/**
 * Synthesised audio for tests. No copyrighted music: everything here is generated
 * from sines, saws and noise so the fixtures can be rebuilt deterministically.
 */

export interface ClickTrack {
  samples: Float32Array;
  /** True beat times in seconds. */
  beatTimes: number[];
}

/** A click track: a short decaying 1 kHz burst on every beat. */
export function clickTrack(
  bpm: number,
  seconds: number,
  sampleRate: number,
  firstBeat = 0.5,
): ClickTrack {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  const period = 60 / bpm;
  const beatTimes: number[] = [];
  const clickLen = Math.round(0.02 * sampleRate);
  for (let t = firstBeat; t < seconds - 0.05; t += period) {
    beatTimes.push(t);
    const s0 = Math.round(t * sampleRate);
    for (let i = 0; i < clickLen && s0 + i < n; i++) {
      const env = Math.exp(-i / (0.004 * sampleRate));
      samples[s0 + i]! += 0.9 * env * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    }
  }
  return { samples, beatTimes };
}

const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

type Timbre = 'saw' | 'sine' | 'square';

interface SectionDef {
  timbre: Timbre;
  /** One chord (MIDI notes) per bar, cycling. */
  chords: number[][];
}

/** Different chord loops for sections A, B and C. */
export const SECTION_DEFS: Record<string, SectionDef> = {
  A: {
    timbre: 'saw',
    chords: [
      [60, 64, 67], // C
      [57, 60, 64], // Am
      [53, 57, 60], // F
      [55, 59, 62], // G
    ],
  },
  B: {
    timbre: 'sine',
    chords: [
      [62, 65, 69], // Dm
      [58, 62, 65], // Bb
      [55, 58, 62], // Gm
      [57, 61, 64], // A
    ],
  },
  C: {
    timbre: 'square',
    chords: [
      [64, 68, 71], // E
      [61, 64, 68], // C#m
      [57, 61, 64], // A
      [59, 63, 66], // B
    ],
  },
};

export interface SynthSong {
  samples: Float32Array;
  sampleRate: number;
  bpm: number;
  beatsPerBar: number;
  /** True beat times in seconds. */
  beatTimes: number[];
  /** Bar start times in seconds (downbeats). */
  barTimes: number[];
  sections: { label: string; start: number; end: number }[];
  duration: number;
}

export interface SynthSongOptions {
  /** e.g. "ABABCA". Letters must be keys of SECTION_DEFS. */
  structure?: string;
  bpm?: number;
  sampleRate?: number;
  barsPerSection?: number;
  beatsPerBar?: number;
  /** Silence before the first downbeat, in seconds. */
  leadIn?: number;
}

function addHarmonics(
  out: Float32Array,
  start: number,
  length: number,
  hz: number,
  timbre: Timbre,
  amp: number,
  sampleRate: number,
): void {
  const harmonics: [number, number][] =
    timbre === 'saw'
      ? [1, 2, 3, 4, 5, 6].map((k) => [k, 1 / k])
      : timbre === 'sine'
        ? [
            [1, 1],
            [2, 0.35],
          ]
        : [1, 3, 5, 7].map((k) => [k, 1 / k]);
  const attack = Math.round(0.01 * sampleRate);
  const release = Math.round(0.03 * sampleRate);
  for (const [k, a] of harmonics) {
    const f = hz * k;
    if (f > sampleRate / 2.2) continue;
    const w = (2 * Math.PI * f) / sampleRate;
    for (let i = 0; i < length && start + i < out.length; i++) {
      let env = 1;
      if (i < attack) env = i / attack;
      else if (i > length - release) env = Math.max(0, (length - i) / release);
      out[start + i]! += amp * a * env * Math.sin(w * i);
    }
  }
}

function addKick(out: Float32Array, start: number, amp: number, sampleRate: number): void {
  const len = Math.round(0.16 * sampleRate);
  let phase = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / sampleRate;
    const f = 48 + 90 * Math.exp(-t / 0.025);
    phase += (2 * Math.PI * f) / sampleRate;
    out[start + i]! += amp * Math.exp(-t / 0.07) * Math.sin(phase);
  }
}

function addHat(out: Float32Array, start: number, amp: number, sampleRate: number, seed: number): void {
  const len = Math.round(0.03 * sampleRate);
  let x = (seed * 2654435761) >>> 0 || 1;
  let prev = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const noise = x / 2147483648 - 1;
    const hp = noise - prev; // crude high-pass
    prev = noise;
    out[start + i]! += amp * hp * Math.exp(-i / (0.008 * sampleRate));
  }
}

/**
 * A synthetic "song" with structure like A B A B C A: each letter is a different chord
 * loop (different chords and timbre) over a four-on-the-floor kick with an accented
 * downbeat, a bass note on each downbeat and off-beat hats.
 */
export function synthSong(options: SynthSongOptions = {}): SynthSong {
  const structure = options.structure ?? 'ABABCA';
  const bpm = options.bpm ?? 120;
  const sampleRate = options.sampleRate ?? 22050;
  const barsPerSection = options.barsPerSection ?? 4;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const leadIn = options.leadIn ?? 0;

  const beat = 60 / bpm;
  const bar = beat * beatsPerBar;
  const totalBars = structure.length * barsPerSection;
  const duration = leadIn + totalBars * bar + 0.5;
  const out = new Float32Array(Math.round(duration * sampleRate));
  const beatTimes: number[] = [];
  const barTimes: number[] = [];
  const sections: SynthSong['sections'] = [];

  for (let s = 0; s < structure.length; s++) {
    const label = structure[s]!;
    const def = SECTION_DEFS[label];
    if (!def) throw new Error(`unknown section ${label}`);
    const sectionStart = leadIn + s * barsPerSection * bar;
    sections.push({ label, start: sectionStart, end: sectionStart + barsPerSection * bar });
    for (let b = 0; b < barsPerSection; b++) {
      const barStart = sectionStart + b * bar;
      barTimes.push(barStart);
      const chord = def.chords[b % def.chords.length]!;
      const barLen = Math.round(bar * sampleRate);
      const s0 = Math.round(barStart * sampleRate);
      for (const note of chord) addHarmonics(out, s0, barLen, midiToHz(note), def.timbre, 0.11, sampleRate);
      // Bass on the downbeat
      addHarmonics(out, s0, Math.round(beat * 1.5 * sampleRate), midiToHz(chord[0]! - 24), 'sine', 0.3, sampleRate);
      for (let k = 0; k < beatsPerBar; k++) {
        const t = barStart + k * beat;
        beatTimes.push(t);
        addKick(out, Math.round(t * sampleRate), k === 0 ? 0.9 : 0.6, sampleRate);
        addHat(out, Math.round((t + beat / 2) * sampleRate), 0.12, sampleRate, s * 1000 + b * 10 + k);
      }
    }
  }

  // Keep headroom.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i]! *= 0.95 / peak;

  return { samples: out, sampleRate, bpm, beatsPerBar, beatTimes, barTimes, sections, duration };
}

/** A constant-amplitude sine wave. */
export function sine(hz: number, seconds: number, sampleRate: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}
