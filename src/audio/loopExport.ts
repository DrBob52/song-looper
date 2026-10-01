import type { LoopRegion, Plan, SeamPlan } from '../model';
import { MAX_REPEATS } from '../model';
import { sanitizeFilename } from '../util/filename';
import { formatClock } from '../util/time';
import { RENDER_CONFIG } from './config';
import { currentSeam } from './path';
import { RangeRenderer, cycleSamples, fadeWindow, makeMid, seamCorrelation } from './render';
import type { RenderOptions } from './render';
import type { AudioBufferLike } from './types';

// SPEC-v1.3.md 7.1: one loop as an audio file of its own. The loop's played span, repeated N times with the app's normal
// seam between passes (rendered by RangeRenderer, the code the preview and the extended export use), and optionally made
// loop-ready: the last W samples are crossfaded with the song just before the loop's start, so a DAW or sampler that
// repeats the file end-to-start hears the song's own lead-in into the loop's first sample instead of a jump.

/** The shortest wrap crossfade of a loop-ready file, in milliseconds. */
export const LOOP_READY_MIN_MS = 10;

/**
 * The seam plan a loop file is rendered with: the loop's own plan, except that a bridge is left out. The span is still
 * the plan's rotated one (`loopStart` .. `loopEnd`); with a bridge the passes are joined by a plain jump from the end of
 * that span back to its start, with the global Seam fade.
 */
function fileSeam(region: LoopRegion): SeamPlan | null {
  const plan = currentSeam(region);
  if (!plan) return null;
  if (!plan.bridge && plan.jumps.length === 1) return plan;
  return { ...plan, bridge: null, jumps: [{ from: plan.loopEnd, to: plan.loopStart }] };
}

/**
 * The plan of a loop file: just this loop, played `repeats` times (1 to 9,999), with no bridge, no cuts and no ending.
 * The file is the stretch of `renderRange` over this plan that starts at the loop and holds its repeats.
 */
export function loopFilePlan(region: LoopRegion, repeats: number): Plan {
  const { seam: _own, bridge: _bridge, ...rest } = region;
  const seam = fileSeam(region);
  const n = Math.min(MAX_REPEATS, Math.max(1, Math.round(repeats) || 1));
  return { regions: [{ ...rest, repeats: n, bridge: false, ...(seam ? { seam } : {}) }] };
}

/** Where a loop file lies in the song and how long it is, in samples (see LoopFileRenderer). */
export interface LoopFileLayout {
  /** The loop's first sample: where the file starts in the source (and in the plan's output, there being nothing before it). */
  start: number;
  /** The loop's own end (the final pass plays through to here). */
  end: number;
  /** Samples one extra repeat adds (the loop, as the cycle plays it). */
  cycle: number;
  /** Frames of the file for N repeats: (N - 1) * cycle + (end - start). */
  frames(repeats: number): number;
}

export function loopFileLayout(buffer: AudioBufferLike, region: LoopRegion, options: Pick<RenderOptions, 'snapZeroCrossings'> = {}): LoopFileLayout {
  const renderer = new RangeRenderer(buffer, loopFilePlan(region, 2), options);
  const r = renderer.regions[0];
  if (!r) throw new Error('That loop is empty.');
  const cycle = cycleSamples(r);
  return { start: r.start, end: r.end, cycle, frames: (repeats) => (Math.max(1, repeats) - 1) * cycle + (r.end - r.start) };
}

export interface LoopFileOptions extends RenderOptions {
  /** Crossfade the last W samples with the song before the loop's start (default true). */
  loopReady?: boolean;
}

/**
 * Renders a loop file piece by piece, like RangeRenderer renders the extended song. It is built on a plan with just the
 * loop (`loopFilePlan`): the file is that plan's output from the loop's first sample for `total` frames, so with
 * `loopReady` off it equals `renderRange` over that span bit for bit.
 *
 * Loop-ready: the last `wrapFrames` samples (W: the Seam fade length, at least 10 ms) are replaced by an equal-power
 * crossfade (blending toward equal-gain when the two sides correlate, the law every seam uses) from what the file would have
 * played, `orig[end - W, end)`, to the song just before the loop, `orig[start - W, start)`. The sample after the last one is
 * then the loop's first, `orig[start]`, which the song itself plays after `orig[start - 1]`. Where the song does not reach
 * back W samples (the loop starts near 0) the missing part is silence, so that stretch fades out.
 */
export class LoopFileRenderer {
  readonly sampleRate: number;
  readonly channelCount: number;
  /** Frames in the file. */
  readonly total: number;
  /** Frames of the wrap crossfade at the end of the file (0: not loop-ready). */
  readonly wrapFrames: number;
  private inner: RangeRenderer;
  private start: number;
  private win: { out: Float32Array; inn: Float32Array } | null = null;

  constructor(
    private buffer: AudioBufferLike,
    /** A plan with just the loop (see loopFilePlan). */
    plan: Plan,
    options: LoopFileOptions = {},
  ) {
    this.sampleRate = buffer.sampleRate;
    this.channelCount = buffer.numberOfChannels;
    this.inner = new RangeRenderer(buffer, plan, options);
    const r = this.inner.regions[0];
    if (!r) throw new Error('That loop is empty.');
    this.start = r.start;
    this.total = (r.repeats - 1) * cycleSamples(r) + (r.end - r.start);
    this.wrapFrames = 0;
    if (options.loopReady === false) return;
    const ms = Math.max(LOOP_READY_MIN_MS, options.crossfadeMs ?? RENDER_CONFIG.crossfadeMs);
    const half = Math.min(Math.floor((ms / 1000) * buffer.sampleRate * 0.5), Math.floor(this.total / 2));
    if (half < 1) return;
    this.wrapFrames = half * 2;
    const adaptive = options.adaptiveCrossfade ?? RENDER_CONFIG.adaptiveCrossfade;
    // the correlation of the two sides over the window: the file's last 2 * half samples against the song before the loop
    const rho = adaptive ? seamCorrelation(makeMid(buffer), buffer.length, r.start - half, r.end - half, half) : 0;
    this.win = fadeWindow(half, rho);
  }

  /** Frames [from, from + length) of the file, one Float32Array per channel (cut at the end of the file). */
  render(from: number, length: number): Float32Array[] {
    const a = Math.min(this.total, Math.max(0, Math.floor(from)));
    const b = Math.min(this.total, Math.max(a, Math.floor(from) + Math.floor(length)));
    const out = this.inner.render(this.start + a, b - a);
    const w = this.win;
    if (!w) return out;
    const tail = this.total - this.wrapFrames;
    if (b <= tail) return out;
    for (let c = 0; c < out.length; c++) {
      const src = this.buffer.getChannelData(c);
      const at = (i: number): number => (i < 0 || i >= src.length ? 0 : src[i]!);
      const piece = out[c]!;
      for (let q = Math.max(a, tail); q < b; q++) {
        const k = q - tail;
        piece[q - a] = w.out[k]! * piece[q - a]! + w.inn[k]! * at(this.start - this.wrapFrames + k);
      }
    }
    return out;
  }
}

/**
 * The default file name of a loop export: `<song name> - Loop <n> (<start>-<end>).wav`, the times as `m.ss.mmm` (a colon is
 * not allowed in a Windows file name), and every character a file system dislikes replaced.
 */
export function loopFileName(songName: string, loopNumber: number, start: number, end: number): string {
  const stem = songName.replace(/\.[^./\\]+$/, '').trim().slice(0, 120) || 'song';
  const t = (seconds: number): string => formatClock(seconds).replace(/:/g, '.');
  return sanitizeFilename(`${stem} - Loop ${loopNumber} (${t(start)}-${t(end)}).wav`);
}
