import type { LoopRegion } from '../model';
import { RENDER_CONFIG } from './config';
import type { Part, RenderOptions, SampleRegion } from './render';
import { regionsToSamples, stitch } from './render';
import type { AudioBufferLike } from './types';

/** What a loop needs to be auditioned: its points, and optionally the seam plan (and bridge) it plays with. */
export type PreviewRegion = Pick<LoopRegion, 'start' | 'end'> & Partial<Pick<LoopRegion, 'seam'>>;

/** Where a stretch of the output comes from in the song: output sample `out` plays source sample `src` onward. */
export interface SourceMapEntry {
  out: number;
  src: number;
}

export interface Snippet {
  channels: Float32Array[];
  sampleRate: number;
  /** Index in `channels` of the jump back to the loop's start (the last seam of the loop). */
  seamIndex: number;
  /** Where each stretch of the snippet comes from in the song, ascending by `out`. */
  map: SourceMapEntry[];
}

export interface LoopBody {
  channels: Float32Array[];
  sampleRate: number;
  /** Original-song time (seconds) of the first sample of the body. */
  originalStart: number;
  /** Where each stretch of the body comes from in the song (a bridge plays other parts of it). */
  map: SourceMapEntry[];
}

function sampleRegion(buffer: AudioBufferLike, region: PreviewRegion, options: RenderOptions): SampleRegion {
  const snapped = regionsToSamples(
    buffer,
    { regions: [{ id: 'r', start: region.start, end: region.end, repeats: 2, color: '', seam: region.seam }] },
    options,
  )[0];
  if (!snapped) throw new Error('That loop is empty.');
  return snapped;
}

/** Position in the output -> time in the song, using a source map. */
export function mapToSource(map: readonly SourceMapEntry[], out: number, sampleRate: number): number {
  let k = 0;
  for (let i = 0; i < map.length; i++) if (map[i]!.out <= out) k = i;
  const e = map[k]!;
  return (e.src + (out - e.out)) / sampleRate;
}

/**
 * Seam audition (spec section 6): the last `seconds` before the loop end, the jump (through a bridge, if the loop
 * has one) back to the loop start, through the same zero-crossing snap, crossfade and level ramp as renderExtended,
 * then the first `seconds` after the start. Equivalent to rendering a two-repeat plan and cutting the window around
 * its seam, without rendering the whole region.
 */
export function renderSeamSnippet(
  buffer: AudioBufferLike,
  region: PreviewRegion,
  options: RenderOptions = {},
  seconds: number = RENDER_CONFIG.seamAuditionSeconds,
): Snippet {
  const sr = buffer.sampleRate;
  const r = sampleRegion(buffer, region, options);
  const lead = Math.min(Math.round(seconds * sr), r.end);
  const tail = Math.round(seconds * sr);
  const back = r.jumps[r.jumps.length - 1]!;
  const parts: Part[] = [{ start: r.end - lead, end: r.pieces[0]!.end }];
  for (let i = 1; i < r.pieces.length; i++) {
    const via = r.jumps[i - 1]!;
    parts.push({ start: r.pieces[i]!.start, end: r.pieces[i]!.end, jump: { fadeMs: via.fadeMs, gain: via.gain, ramp: via.ramp } });
  }
  parts.push({ start: r.start, end: r.start + tail, jump: { fadeMs: back.fadeMs, gain: back.gain, ramp: back.ramp } });
  const { channels, partStarts } = stitch(buffer, parts, options);
  return {
    channels,
    sampleRate: sr,
    seamIndex: partStarts[partStarts.length - 1]!,
    map: parts.map((p, i) => ({ out: partStarts[i]!, src: p.start })),
  };
}

/**
 * One period of the looped region exactly as renderExtended plays it (including the crossfaded seams and, with a
 * bridge, the bridge), so that looping [0, length) is seamless and equals what the export contains. It is the
 * middle cycle of three stitched ones.
 */
export function renderLoopBody(buffer: AudioBufferLike, region: PreviewRegion, options: RenderOptions = {}): LoopBody {
  const sr = buffer.sampleRate;
  const r = sampleRegion(buffer, region, options);
  const back = r.jumps[r.jumps.length - 1]!;
  const parts: Part[] = [];
  for (let k = 0; k < 3; k++) {
    r.pieces.forEach((p, i) => {
      const via = i === 0 ? (k === 0 ? undefined : back) : r.jumps[i - 1]!;
      parts.push({ start: p.start, end: p.end, jump: via && { fadeMs: via.fadeMs, gain: via.gain, ramp: via.ramp } });
    });
  }
  const period = r.pieces.reduce((s, p) => s + (p.end - p.start), 0);
  const { channels: three, partStarts } = stitch(buffer, parts, options);
  const channels = three.map((c) => c.slice(period, 2 * period));
  const n = r.pieces.length;
  const map = r.pieces.map((p, i) => ({ out: partStarts[n + i]! - period, src: p.start }));
  return { channels, sampleRate: sr, originalStart: r.start / sr, map };
}
