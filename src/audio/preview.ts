import type { LoopRegion } from '../model';
import { RENDER_CONFIG } from './config';
import type { RenderOptions } from './render';
import { makeMid, regionsToSamples, seamFade } from './render';
import type { AudioBufferLike } from './types';

type Edges = Pick<LoopRegion, 'start' | 'end'>;

export interface Snippet {
  channels: Float32Array[];
  sampleRate: number;
  /** Index in `channels` of the seam (the jump from region end back to region start). */
  seamIndex: number;
}

export interface LoopBody {
  channels: Float32Array[];
  sampleRate: number;
  /** Original-song time (seconds) of the first sample of the body. */
  originalStart: number;
}

function snapEdges(buffer: AudioBufferLike, region: Edges, options: RenderOptions): { start: number; end: number } {
  const snapped = regionsToSamples(
    buffer,
    { regions: [{ id: 'r', start: region.start, end: region.end, repeats: 2, color: '' }] },
    options,
  )[0];
  if (!snapped) throw new Error('That loop is empty.');
  return snapped;
}

/**
 * Seam audition (spec section 6): the last `seconds` before the region end, the jump back to
 * the region start (through the same zero-crossing snap and crossfade as renderExtended), then
 * the first `seconds` after the start. Equivalent to rendering a two-repeat plan and cutting
 * the window around its seam, without rendering the whole region.
 */
export function renderSeamSnippet(
  buffer: AudioBufferLike,
  region: Edges,
  options: RenderOptions = {},
  seconds: number = RENDER_CONFIG.seamAuditionSeconds,
): Snippet {
  const sr = buffer.sampleRate;
  const length = buffer.length;
  const { start: s, end: e } = snapEdges(buffer, region, options);
  const lead = Math.min(Math.round(seconds * sr), e);
  const tail = Math.round(seconds * sr);
  const fade = seamFade(makeMid(buffer), length, sr, { start: s, end: e }, options);
  const half = fade ? fade.out.length / 2 : 0;
  const total = lead + tail;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const at = (i: number): number => (i < 0 || i >= length ? 0 : src[i]!);
    const out = new Float32Array(total);
    for (let k = 0; k < total; k++) out[k] = k < lead ? at(e - lead + k) : at(s + k - lead);
    if (fade) {
      for (let i = 0; i < half * 2; i++) {
        const k = lead - half + i;
        if (k >= 0 && k < total) out[k] = fade.out[i]! * at(e - half + i) + fade.inn[i]! * at(s - half + i);
      }
    }
    channels.push(out);
  }
  return { channels, sampleRate: sr, seamIndex: lead };
}

/**
 * One period of the looped region exactly as renderExtended plays it (including the crossfaded
 * seam), so that looping [0, length) is seamless and equals what the export contains.
 */
export function renderLoopBody(buffer: AudioBufferLike, region: Edges, options: RenderOptions = {}): LoopBody {
  const sr = buffer.sampleRate;
  const length = buffer.length;
  const { start: s, end: e } = snapEdges(buffer, region, options);
  const period = e - s;
  const fade = seamFade(makeMid(buffer), length, sr, { start: s, end: e }, options);
  const half = fade ? fade.out.length / 2 : 0;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const at = (i: number): number => (i < 0 || i >= length ? 0 : src[i]!);
    const body = new Float32Array(period);
    body.set(src.subarray(s, e));
    if (fade) {
      // Position j of the body is output position seam + j. The head is the second half of the
      // seam window; the tail (negative j) is the first half of the next seam's window.
      for (let i = 0; i < half; i++) {
        body[i] = fade.out[half + i]! * at(e + i) + fade.inn[half + i]! * at(s + i);
        const j = period - half + i;
        body[j] = fade.out[i]! * at(e - half + i) + fade.inn[i]! * at(s - half + i);
      }
    }
    channels.push(body);
  }
  return { channels, sampleRate: sr, originalStart: s / sr };
}
