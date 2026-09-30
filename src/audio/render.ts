import type { LoopRegion, Plan } from '../model';
import { MAX_REPEATS } from '../model';
import { RENDER_CONFIG } from './config';
import type { AudioBufferLike } from './types';

export type { LoopRegion, Plan } from '../model';

// ---------------------------------------------------------------------------
// Timeline (seconds)
// ---------------------------------------------------------------------------

export interface Segment {
  /** `original` is plain song audio; `repeat` is one play of a loop region. */
  kind: 'original' | 'repeat';
  /** Source span in the original song. */
  start: number;
  end: number;
  /** Position in the extended output. */
  outStart: number;
  outEnd: number;
  regionId?: string;
  /** 1-based repeat number within the region. */
  repeat?: number;
  repeats?: number;
}

/**
 * Sort regions, clip them to [0, duration], drop empty ones, trim overlaps, and clamp
 * repeat counts to 1..MAX_REPEATS. The result is what the renderer actually uses.
 */
export function normalizeRegions(regions: readonly LoopRegion[], duration: number): LoopRegion[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: LoopRegion[] = [];
  let cursor = 0;
  for (const r of sorted) {
    const start = Math.max(cursor, Math.max(0, r.start));
    const end = Math.min(duration, r.end);
    if (!(end > start)) continue;
    const repeats = Math.min(MAX_REPEATS, Math.max(1, Math.round(r.repeats || 1)));
    out.push({ ...r, start, end, repeats });
    cursor = end;
  }
  return out;
}

/**
 * The output layout as a list of segments over the original:
 * [0, r1.start) -> r1 x repeats1 -> [r1.end, r2.start) -> ... -> [rk.end, duration).
 * repeats = 1 everywhere gives back the original song.
 */
export function buildTimeline(plan: Plan, duration: number): Segment[] {
  const regions = normalizeRegions(plan.regions, duration);
  const segments: Segment[] = [];
  let out = 0;
  let cursor = 0;
  const pushOriginal = (start: number, end: number): void => {
    if (end <= start) return;
    segments.push({ kind: 'original', start, end, outStart: out, outEnd: out + (end - start) });
    out += end - start;
  };
  for (const r of regions) {
    pushOriginal(cursor, r.start);
    const len = r.end - r.start;
    for (let k = 1; k <= r.repeats; k++) {
      segments.push({
        kind: 'repeat',
        start: r.start,
        end: r.end,
        outStart: out,
        outEnd: out + len,
        regionId: r.id,
        repeat: k,
        repeats: r.repeats,
      });
      out += len;
    }
    cursor = r.end;
  }
  pushOriginal(cursor, duration);
  return segments;
}

/** Length of the extended output in seconds: D + sum((repeats - 1) * regionLength). */
export function extendedDuration(plan: Plan, duration: number): number {
  let total = duration;
  for (const r of normalizeRegions(plan.regions, duration)) total += (r.repeats - 1) * (r.end - r.start);
  return total;
}

/** Map a position in the extended output back to the original song. */
export function extendedToOriginal(timeline: Segment[], t: number): { time: number; segment: Segment | null } {
  if (timeline.length === 0) return { time: 0, segment: null };
  for (const seg of timeline) {
    if (t < seg.outEnd) return { time: seg.start + Math.max(0, t - seg.outStart), segment: seg };
  }
  const last = timeline[timeline.length - 1]!;
  return { time: last.end, segment: last };
}

/** Map an original-song time to the extended output (first play of any region). */
export function originalToExtended(timeline: Segment[], t: number): number {
  for (const seg of timeline) {
    if (seg.kind === 'repeat' && seg.repeat !== 1) continue;
    if (t >= seg.start && t < seg.end) return seg.outStart + (t - seg.start);
  }
  const last = timeline[timeline.length - 1];
  if (!last) return 0;
  // Past the end, or only reachable after a region's later repeats: clamp to the end.
  return t >= last.end ? last.outEnd : 0;
}

/** Signature of everything that changes the rendered output, for caching. */
export function planKey(plan: Plan, duration: number, crossfadeMs: number): string {
  const regions = normalizeRegions(plan.regions, duration);
  return JSON.stringify([
    crossfadeMs,
    regions.map((r) => [r.start.toFixed(6), r.end.toFixed(6), r.repeats]),
  ]);
}

// ---------------------------------------------------------------------------
// Sample-domain rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Seam crossfade length in ms (0 disables it). Default RENDER_CONFIG.crossfadeMs. */
  crossfadeMs?: number;
  /** Snap loop edges to zero crossings first. Default true. */
  snapZeroCrossings?: boolean;
  /** Blend toward equal-gain when both sides of a seam are correlated. Default RENDER_CONFIG.adaptiveCrossfade. */
  adaptiveCrossfade?: boolean;
  onProgress?: (fraction: number) => void;
}

/** A loop region in sample indices, after zero-crossing snapping. */
export interface SampleRegion {
  id: string;
  start: number;
  end: number;
  repeats: number;
}

type Slope = 1 | -1 | 0;

/** Mean across channels ("mid"), computed on demand. */
export function makeMid(buffer: AudioBufferLike): (i: number) => number {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const n = chans.length;
  if (n === 1) {
    const d = chans[0]!;
    return (i) => d[i]!;
  }
  return (i) => {
    let s = 0;
    for (let c = 0; c < n; c++) s += chans[c]![i]!;
    return s / n;
  };
}

function crossingSlope(mid: (i: number) => number, i: number, length: number): Slope {
  if (i < 1 || i >= length) return 0;
  const a = mid(i - 1);
  const b = mid(i);
  if (a < 0 && b >= 0) return 1;
  if (a > 0 && b <= 0) return -1;
  return 0;
}

/**
 * Nearest zero crossing to `index` within +-`radius` samples, looking at the mid channel.
 * When `prefer` is 1 or -1, a crossing with that slope wins if one exists in range. Returns
 * the index unchanged when there is none. `slope` is the slope of the chosen crossing.
 */
export function snapToZeroCrossing(
  mid: (i: number) => number,
  length: number,
  index: number,
  radius: number,
  prefer: Slope = 0,
): { index: number; slope: Slope } {
  const search = (want: Slope): { index: number; slope: Slope } | null => {
    for (let d = 0; d <= radius; d++) {
      for (const i of d === 0 ? [index] : [index - d, index + d]) {
        const s = crossingSlope(mid, i, length);
        if (s !== 0 && (want === 0 || s === want)) return { index: i, slope: s };
      }
    }
    return null;
  };
  return (prefer !== 0 ? search(prefer) : null) ?? search(0) ?? { index, slope: 0 };
}

/**
 * Convert a plan to sample indices, snapping each region's edges to zero crossings
 * (both channels move together because the search runs on the mid channel).
 */
export function regionsToSamples(
  buffer: AudioBufferLike,
  plan: Plan,
  options: Pick<RenderOptions, 'snapZeroCrossings'> = {},
): SampleRegion[] {
  const sr = buffer.sampleRate;
  const length = buffer.length;
  const regions = normalizeRegions(plan.regions, buffer.duration);
  const snap = options.snapZeroCrossings ?? true;
  const radius = Math.round((RENDER_CONFIG.zeroCrossRadiusMs / 1000) * sr);
  const mid = snap ? makeMid(buffer) : null;
  const out: SampleRegion[] = [];
  let cursor = 0;
  for (const r of regions) {
    let start = Math.min(length, Math.max(0, Math.round(r.start * sr)));
    let end = Math.min(length, Math.max(0, Math.round(r.end * sr)));
    if (mid) {
      const a = snapToZeroCrossing(mid, length, start, radius);
      const b = snapToZeroCrossing(mid, length, end, radius, a.slope);
      start = a.index;
      end = b.index;
    }
    start = Math.max(start, cursor);
    if (end <= start) continue;
    out.push({ id: r.id, start, end, repeats: r.repeats });
    cursor = end;
  }
  return out;
}

export function renderedLength(regions: SampleRegion[], length: number): number {
  let total = length;
  for (const r of regions) total += (r.repeats - 1) * (r.end - r.start);
  return total;
}

interface FadeWindow {
  out: Float32Array;
  inn: Float32Array;
}

/**
 * Fade gains for a seam window of `2 * half` samples. `rho` in [0, 1] is the correlation
 * of the two sides: 0 gives equal-power gains (cos/sin), 1 gives equal-gain (linear).
 */
export function fadeWindow(half: number, rho = 0): FadeWindow {
  const w = half * 2;
  const out = new Float32Array(w);
  const inn = new Float32Array(w);
  for (let i = 0; i < w; i++) {
    const t = (i + 0.5) / w;
    const theta = t * (Math.PI / 2);
    out[i] = (1 - rho) * Math.cos(theta) + rho * (1 - t);
    inn[i] = (1 - rho) * Math.sin(theta) + rho * t;
  }
  return { out, inn };
}

/** Normalised correlation (clamped to [0, 1]) of the audio on each side of a seam, on the mid channel. */
function seamCorrelation(mid: (i: number) => number, length: number, s: number, e: number, half: number): number {
  const at = (i: number): number => (i < 0 || i >= length ? 0 : mid(i));
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < half * 2; i++) {
    const a = at(e - half + i);
    const b = at(s - half + i);
    ab += a * b;
    aa += a * a;
    bb += b * b;
  }
  const denom = Math.sqrt(aa * bb);
  return denom > 1e-12 ? Math.max(0, Math.min(1, ab / denom)) : 0;
}

/**
 * The fade used at a region's seam, or null if there is no room/need for one. Shared by the
 * export renderer and the audition/preview renderers so they always sound the same.
 */
export function seamFade(
  mid: (i: number) => number,
  length: number,
  sampleRate: number,
  region: { start: number; end: number },
  options: Pick<RenderOptions, 'crossfadeMs' | 'adaptiveCrossfade'> = {},
): FadeWindow | null {
  const crossfadeMs = options.crossfadeMs ?? RENDER_CONFIG.crossfadeMs;
  const adaptive = options.adaptiveCrossfade ?? RENDER_CONFIG.adaptiveCrossfade;
  const halfFull = Math.max(0, Math.floor((crossfadeMs / 1000) * sampleRate * 0.5));
  const half = Math.min(halfFull, Math.floor((region.end - region.start) / 2));
  if (half < 1) return null;
  return fadeWindow(half, adaptive ? seamCorrelation(mid, length, region.start, region.end, half) : 0);
}

/**
 * Render the extended song: copy the timeline's segments and equal-power crossfade each
 * jump from a region's end back to its start. Samples beyond the buffer edges read as
 * silence. Returns one Float32Array per channel. Output length is
 * length + sum((repeats - 1) * regionLength).
 */
export function renderExtended(
  buffer: AudioBufferLike,
  plan: Plan,
  options: RenderOptions = {},
): Float32Array[] {
  const sr = buffer.sampleRate;
  const length = buffer.length;
  const regions = regionsToSamples(buffer, plan, options);
  const total = renderedLength(regions, length);
  if (total / sr > RENDER_CONFIG.maxExtendedSeconds) {
    throw new Error(
      `The extended song would be ${(total / sr / 60).toFixed(1)} minutes long. The limit is ${RENDER_CONFIG.maxExtendedSeconds / 60} minutes; lower a repeat count.`,
    );
  }
  const mid = makeMid(buffer);
  // One fade per region, shared by all channels and repeats so the stereo image stays aligned
  // and every repeat of a seam is identical (which also makes a rendered loop periodic).
  const fades: (FadeWindow | null)[] = regions.map((r) =>
    r.repeats < 2 ? null : seamFade(mid, length, sr, r, options),
  );

  const outChannels: Float32Array[] = [];
  const nCh = buffer.numberOfChannels;
  for (let c = 0; c < nCh; c++) {
    const src = buffer.getChannelData(c);
    const out = new Float32Array(total);
    const at = (i: number): number => (i < 0 || i >= length ? 0 : src[i]!);
    let cursor = 0; // read position in the source
    let pos = 0; // write position in the output
    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri]!;
      out.set(src.subarray(cursor, r.start), pos);
      pos += r.start - cursor;
      const regionOutStart = pos;
      const len = r.end - r.start;
      const body = src.subarray(r.start, r.end);
      for (let k = 0; k < r.repeats; k++) {
        out.set(body, pos);
        pos += len;
      }
      const win = fades[ri];
      if (win) {
        const half = win.out.length / 2;
        for (let k = 1; k < r.repeats; k++) {
          const seam = regionOutStart + k * len;
          const base = seam - half;
          for (let i = 0; i < half * 2; i++) {
            out[base + i] = win.out[i]! * at(r.end - half + i) + win.inn[i]! * at(r.start - half + i);
          }
        }
      }
      cursor = r.end;
      options.onProgress?.((c + (ri + 1) / (regions.length + 1)) / nCh);
    }
    out.set(src.subarray(cursor, length), pos);
    outChannels.push(out);
  }
  options.onProgress?.(1);
  return outChannels;
}
