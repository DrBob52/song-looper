/**
 * Writes a synthetic demo song (chord loops A B A B C A over a four-on-the-floor kick) to a WAV file, so the app
 * can be tried without any copyrighted music.
 *
 *   npm run demo-song                 # writes tests/fixtures/demo-song.generated.wav
 *   npm run demo-song -- out.wav 128  # custom path and tempo
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeWavBytes } from '../src/audio/wav';
import { synthSong } from '../tests/fixtures/synth';

const out = process.argv[2] ?? 'tests/fixtures/demo-song.generated.wav';
const bpm = Number(process.argv[3] ?? 120);
const song = synthSong({ sampleRate: 44100, bpm, structure: 'ABABCA', barsPerSection: 8 });
const right = Float32Array.from(song.samples, (v) => v * 0.92);
const bytes = await encodeWavBytes([song.samples, right], song.sampleRate, { bitDepth: 16 });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
console.log(`wrote ${out}: ${song.duration.toFixed(1)} s, ${bpm} BPM, sections ${song.sections.map((s) => s.label).join('')}`);
