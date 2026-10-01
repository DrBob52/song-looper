import { SONG1, SONG2 } from '../tests/fixtures/synth';
import { analyseChordSong } from '../tests/unit/chordHelpers';
const f = (v: number | null) => (v === null ? 'null' : v.toFixed(2));
for (const [nm, def] of [['song1', SONG1], ['song2', SONG2]] as const) {
  const a = analyseChordSong(def);
  const secs = a.song.sections;
  const reqs = [] as { id: string; start: number; end: number }[];
  secs.forEach((x, i) => reqs.push({ id: `${x.label}${i}`, start: x.start, end: x.end }));
  for (let i = 0; i + 1 < secs.length; i++) reqs.push({ id: `${secs[i]!.label}${secs[i + 1]!.label}@${i}`, start: secs[i]!.start, end: secs[i + 1]!.end });
  for (const r of a.session.seamReport(reqs)) {
    console.log(nm, r.id.padEnd(6), `harmony ${f(r.harmony)} ctx ${f(r.contextMatch)} transient ${f(r.scores.transient)} spectral ${f(r.scores.spectral)} quality ${f(r.scores.quality)} chip ${r.chip}`);
  }
}
