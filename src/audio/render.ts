import type { JumpPlan, LoopRegion, Plan } from '../model';
import { MAX_REPEATS } from '../model';
import { RENDER_CONFIG } from './config';
import { cycleSeconds, loopPath } from './path';
import type { AudioBufferLike } from './types';

export type { LoopRegion, Plan } from '../model';

// ---------------------------------------------------------------------------
// Timeline (seconds)
// ---------------------------------------------------------------------------

export interface Segment {
  /**
   * `original` is plain song audio; `repeat` is one play of a loop region; `bridge` is a stretch of the song
   * that follows a loop's end on every repeat but the last (SPEC-seams.md 5).
   */
  kind: 'original' | 'repeat' | 'bridge';
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

/** A normalised region with the seam plan applied: the loop's real edges and the cycle it plays. */
export interface PlannedRegion {
  id: string;
  repeats: number;
  /** The loop's own edges after the seam plan's shift (equal to the region's when there is no plan). */
  start: number;
  end: number;
  /** Source pieces of one cycle and the jumps that join them (see LoopPath). */
  pieces: { start: number; end: number }[];
  jumps: JumpPlan[];
}

/**
 * The regions as they play: normalised, with each region's seam plan (rotation, alignment, bridge) applied. A plan
 * that would put the loop out of the song or into a neighbour is ignored.
 */
export function planRegions(plan: Plan, duration: number): PlannedRegion[] {
  const out: PlannedRegion[] = [];
  let cursor = 0;
  for (const r of normalizeRegions(plan.regions, duration)) {
    let path = loopPath(r);
    const fits = path.start >= cursor - 1e-9 && path.end <= duration + 1e-9 && path.end > path.start;
    const inside = path.pieces.every((p) => p.end > p.start && p.start >= -1e-9 && p.end <= duration + 1e-9);
    if (!fits || !inside) path = loopPath({ start: r.start, end: r.end });
    out.push({ id: r.id, repeats: r.repeats, start: path.start, end: path.end, pieces: path.pieces, jumps: path.jumps });
    cursor = path.end;
  }
  return out;
}

/**
 * The output layout as a list of segments over the original:
 * [0, r1.start) -> r1 x repeats1 -> [r1.end, r2.start) -> ... -> [rk.end, duration).
 * repeats = 1 everywhere gives back the original song. Every repeat but a loop's last is followed by its bridge, if any.
 */
export function buildTimeline(plan: Plan, duration: number): Segment[] {
  const regions = planRegions(plan, duration);
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
      if (k === r.repeats) continue;
      // the bridge: whatever the cycle plays beyond the loop itself
      r.pieces.forEach((p, i) => {
        const start = i === 0 ? r.end : p.start;
        if (p.end - start <= 1e-9) return;
        segments.push({
          kind: 'bridge',
          start,
          end: p.end,
          outStart: out,
          outEnd: out + (p.end - start),
          regionId: r.id,
          repeat: k,
          repeats: r.repeats,
        });
        out += p.end - start;
      });
    }
    cursor = r.end;
  }
  pushOriginal(cursor, duration);
  return segments;
}

/** Length of the extended output in seconds: D + sum((repeats - 1) * (loop + bridge)). */
export function extendedDuration(plan: Plan, duration: number): number {
  let total = duration;
  for (const r of planRegions(plan, duration)) {
    total += (r.repeats - 1) * cycleSeconds(r);
  }
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
    if (seg.kind === 'bridge' || (seg.kind === 'repeat' && seg.repeat !== 1)) continue;
    if (t >= seg.start && t < seg.end) return seg.outStart + (t - seg.start);
  }
  const last = timeline[timeline.length - 1];
  if (!last) return 0;
  // Past the end, or only reachable after a region's later repeats: clamp to the end.
  return t >= last.end ? last.outEnd : 0;
}

/** Signature of everything that changes the rendered output, for caching. */
export function planKey(plan: Plan, duration: number, crossfadeMs: number): string {
  const regions = planRegions(plan, duration);
  const f = (v: number | undefined): string | number => (v === undefined ? 0 : v.toFixed(6));
  return JSON.stringify([
    crossfadeMs,
    regions.map((r) => [
      r.start.toFixed(6),
      r.end.toFixed(6),
      r.repeats,
      r.jumps.map((j) => [f(j.from), f(j.to), f(j.fadeMs), f(j.levelDb), f(j.rampSeconds)]),
    ]),
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

/** One jump in sample indices. */
export interface SampleJump {
  from: number;
  to: number;
  /** Crossfade length in ms for this jump; undefined means the global setting. */
  fadeMs?: number;
  /** Linear gain that the ramp over the last `ramp` samples before the jump reaches (1 = no ramp). */
  gain: number;
  ramp: number;
}

/** A loop region in sample indices, after zero-crossing snapping. */
export interface SampleRegion {
  id: string;
  /** The loop's own edges. */
  start: number;
  end: number;
  repeats: number;
  /** The cycle played on every repeat but the last: source pieces joined by jumps (see LoopPath). */
  pieces: { start: number; end: number }[];
  jumps: SampleJump[];
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
 * Convert a plan to sample indices, snapping each jump's two ends to zero crossings (both channels move
 * together because the search runs on the mid channel). A plain loop has one jump, from its end back to its
 * start, so this is the loop's two edges.
 */
export function regionsToSamples(
  buffer: AudioBufferLike,
  plan: Plan,
  options: Pick<RenderOptions, 'snapZeroCrossings'> = {},
): SampleRegion[] {
  const sr = buffer.sampleRate;
  const length = buffer.length;
  const regions = planRegions(plan, buffer.duration);
  const snap = options.snapZeroCrossings ?? true;
  const radius = Math.round((RENDER_CONFIG.zeroCrossRadiusMs / 1000) * sr);
  const mid = snap ? makeMid(buffer) : null;
  const toIndex = (t: number): number => Math.min(length, Math.max(0, Math.round(t * sr)));
  const out: SampleRegion[] = [];
  let cursor = 0;
  for (const r of regions) {
    const jumps: SampleJump[] = r.jumps.map((j) => ({
      from: toIndex(j.from),
      to: toIndex(j.to),
      fadeMs: j.fadeMs,
      gain: j.levelDb ? 10 ** (j.levelDb / 20) : 1,
      ramp: j.levelDb ? Math.max(0, Math.round((j.rampSeconds ?? 0) * sr)) : 0,
    }));
    let start = toIndex(r.start);
    let end = toIndex(r.end);
    if (mid) {
      const a = snapToZeroCrossing(mid, length, start, radius);
      start = a.index;
      // each jump: the landing point first, then the departure point on a crossing of the same slope
      for (const j of jumps) {
        const to = snapToZeroCrossing(mid, length, j.to, radius);
        const from = snapToZeroCrossing(mid, length, j.from, radius, to.slope);
        j.to = to.index;
        j.from = from.index;
      }
      end = snapToZeroCrossing(mid, length, end, radius, a.slope).index;
    }
    start = Math.max(start, cursor);
    if (end <= start) continue;
    // the jump back to the loop start lands exactly on the loop start
    jumps[jumps.length - 1]!.to = start;
    const pieces = jumps.map((j, k) => ({ start: k === 0 ? start : jumps[k - 1]!.to, end: j.from }));
    if (pieces.some((p) => p.end <= p.start)) {
      // a degenerate plan: fall back to the plain loop
      out.push({
        id: r.id,
        start,
        end,
        repeats: r.repeats,
        pieces: [{ start, end }],
        jumps: [{ from: end, to: start, gain: 1, ramp: 0 }],
      });
    } else {
      out.push({ id: r.id, start, end, repeats: r.repeats, pieces, jumps });
    }
    cursor = end;
  }
  return out;
}

/** Samples that one cycle (loop plus bridge) adds. */
export function cycleSamples(r: SampleRegion): number {
  return r.pieces.reduce((s, p) => s + (p.end - p.start), 0);
}

export function renderedLength(regions: SampleRegion[], length: number): number {
  let total = length;
  for (const r of regions) total += (r.repeats - 1) * cycleSamples(r);
  return total;
}

export interface FadeWindow {
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
export function seamCorrelation(mid: (i: number) => number, length: number, s: number, e: number, half: number): number {
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
  return jumpFade(mid, length, sampleRate, { from: region.end, to: region.start }, Math.floor((region.end - region.start) / 2), options);
}

/** The fade of one jump, `maxHalf` samples at most on either side of it (the pieces it joins may be short). */
function jumpFade(
  mid: (i: number) => number,
  length: number,
  sampleRate: number,
  jump: Pick<SampleJump, 'from' | 'to' | 'fadeMs'>,
  maxHalf: number,
  options: Pick<RenderOptions, 'crossfadeMs' | 'adaptiveCrossfade'>,
): FadeWindow | null {
  const crossfadeMs = jump.fadeMs ?? options.crossfadeMs ?? RENDER_CONFIG.crossfadeMs;
  const adaptive = options.adaptiveCrossfade ?? RENDER_CONFIG.adaptiveCrossfade;
  const halfFull = Math.max(0, Math.floor((crossfadeMs / 1000) * sampleRate * 0.5));
  const half = Math.min(halfFull, maxHalf);
  if (half < 1) return null;
  return fadeWindow(half, adaptive ? seamCorrelation(mid, length, jump.to, jump.from, half) : 0);
}

// ---------------------------------------------------------------------------
// Stitching: the one routine that renders the export, the loop preview and the seam audition
// ---------------------------------------------------------------------------

/** A stretch of the source to copy, and how it joins the stretch before it. */
export interface Part {
  start: number;
  end: number;
  /** Set when the previous part does not lead naturally into this one: it jumps from `prev.end` to `start`. */
  jump?: Pick<SampleJump, 'fadeMs' | 'gain' | 'ramp'>;
}

export interface Stitched {
  channels: Float32Array[];
  /** Output position of the start of each part. */
  partStarts: number[];
}

/**
 * Copy the parts one after another and give every jump its seam: an equal-power crossfade (blending toward
 * equal-gain when both sides correlate) of the stream that would have continued past the end of the previous part
 * with the stream before the start of this one, centred on the join, plus the jump's level ramp over the last
 * `ramp` samples of the previous part. Samples beyond the buffer edges read as silence.
 */
export function stitch(buffer: AudioBufferLike, parts: Part[], options: RenderOptions = {}): Stitched {
  const length = buffer.length;
  const mid = makeMid(buffer);
  const partStarts: number[] = [];
  let total = 0;
  for (const p of parts) {
    partStarts.push(total);
    total += p.end - p.start;
  }
  // One fade per distinct jump, shared by all channels so the stereo image stays aligned and every play of a seam is identical.
  const fades = new Map<string, FadeWindow | null>();
  const fadeOf = (i: number): FadeWindow | null => {
    const part = parts[i]!;
    const prev = parts[i - 1]!;
    const key = `${prev.end}|${part.start}|${part.jump!.fadeMs ?? ''}|${Math.min(prev.end - prev.start, part.end - part.start)}`;
    if (!fades.has(key)) {
      const maxHalf = Math.floor(Math.min(prev.end - prev.start, part.end - part.start) / 2);
      fades.set(key, jumpFade(mid, length, buffer.sampleRate, { from: prev.end, to: part.start, fadeMs: part.jump!.fadeMs }, maxHalf, options));
    }
    return fades.get(key)!;
  };
  const windows = parts.map((p, i) => (i > 0 && p.jump ? fadeOf(i) : null));

  const channels: Float32Array[] = [];
  const nCh = buffer.numberOfChannels;
  for (let c = 0; c < nCh; c++) {
    const src = buffer.getChannelData(c);
    const at = (i: number): number => (i < 0 || i >= length ? 0 : src[i]!);
    const out = new Float32Array(total);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const a = Math.max(0, p.start);
      const b = Math.min(length, p.end);
      if (b > a) out.set(src.subarray(a, b), partStarts[i]! + (a - p.start));
    }
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]!;
      const jump = p.jump;
      if (!jump) continue;
      const prev = parts[i - 1]!;
      const seam = partStarts[i]!;
      const win = windows[i];
      const half = win ? win.out.length / 2 : 0;
      // gain of the stream that leaves the loop end: a ramp over the last `ramp` samples, then held while it fades out
      const ramp = jump.gain === 1 ? 0 : Math.max(0, Math.min(jump.ramp, prev.end - prev.start));
      const gainAt = (offset: number): number =>
        offset >= 0 ? jump.gain : offset < -ramp ? 1 : 1 + (jump.gain - 1) * ((offset + ramp) / ramp);
      if (ramp > 0) {
        for (let q = seam - ramp; q < seam - half; q++) if (q >= 0) out[q] = out[q]! * gainAt(q - seam);
      }
      if (win) {
        for (let k = 0; k < half * 2; k++) {
          const q = seam - half + k;
          if (q < 0 || q >= total) continue;
          out[q] = win.out[k]! * gainAt(k - half) * at(prev.end - half + k) + win.inn[k]! * at(p.start - half + k);
        }
      }
    }
    channels.push(out);
    options.onProgress?.((c + 1) / nCh);
  }
  return { channels, partStarts };
}

/** The parts of one region's play: the original before it, `repeats - 1` cycles, the loop once more, then it flows on. */
export function regionParts(r: SampleRegion, cursor: number): Part[] {
  const parts: Part[] = [{ start: cursor, end: r.start }];
  const back = r.jumps[r.jumps.length - 1]!;
  for (let k = 0; k < r.repeats - 1; k++) {
    r.pieces.forEach((p, i) => {
      const via = i === 0 ? (k === 0 ? undefined : back) : r.jumps[i - 1]!;
      parts.push({ start: p.start, end: p.end, jump: via && { fadeMs: via.fadeMs, gain: via.gain, ramp: via.ramp } });
    });
  }
  // the final repeat: just the loop, entered by the jump back (or naturally, when the loop plays once)
  parts.push({
    start: r.start,
    end: r.end,
    jump: r.repeats > 1 ? { fadeMs: back.fadeMs, gain: back.gain, ramp: back.ramp } : undefined,
  });
  return parts;
}

/**
 * Render the extended song: copy the timeline's segments and equal-power crossfade each jump (a loop's end back
 * to its start, and the jumps of a bridge). Samples beyond the buffer edges read as silence. Returns one
 * Float32Array per channel. Output length is length + sum((repeats - 1) * (loop + bridge)).
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
  const parts: Part[] = [];
  let cursor = 0;
  for (const r of regions) {
    parts.push(...regionParts(r, cursor));
    cursor = r.end;
  }
  parts.push({ start: cursor, end: length });
  const { channels } = stitch(buffer, parts, options);
  options.onProgress?.(1);
  return channels;
}
