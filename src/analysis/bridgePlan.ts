import type { SeamPlan } from '../model';
import type { BridgeSearch } from './bridge';
import type { SeamAnalyzer } from './seam';
import { nearestBeat } from './seam';
import { smoothJumps } from './smooth';
import type { JumpSeed } from './smooth';
import type { SeamScores } from './types';

/** A bridge jump must leave at least this long after the piece before it starts, for its crossfade to have room. */
const MIN_PIECE_SECONDS = 0.05;

/**
 * Turn a bridge path (a list of beat jumps) into a seam plan (SPEC-seams.md 5.2): beat indices become times that keep
 * the seam's phase relative to the beat grid (the offset of the loop start), every jump then gets the same smoothing as
 * a plain seam (shared rotation, per-jump alignment, fade and level) when `smooth` is on, and the plan's scores are
 * those of its weakest jump. Returns null when the result would not be playable (a piece too short or outside the song).
 */
export function planBridge(
  tool: SeamAnalyzer,
  samples: Float32Array,
  sampleRate: number,
  req: { start: number; end: number; minStart?: number; maxEnd?: number },
  smooth: boolean,
  search: BridgeSearch,
): SeamPlan | null {
  const path = search.path;
  if (!path) return null;
  const { beats } = tool.inputs;
  const duration = tool.inputs.duration;
  const { start, end } = req;
  const a = nearestBeat(beats, start);
  const off = start - beats[a]!;
  const after = (i: number): number => (i + 1 < beats.length ? beats[i + 1]! : duration) + off;
  const seeds: JumpSeed[] = path.jumps.map((j, k) => ({
    // a jump that leaves right at the loop's last beat leaves at the loop's own end
    from: k === 0 && path.runBeats === 0 ? end : after(j.from),
    to: j.to === a ? start : beats[j.to]! + off,
  }));
  const minStart = Math.max(0, req.minStart ?? 0);
  const maxEnd = Math.min(duration, req.maxEnd ?? duration);
  const r = smoothJumps(tool, samples, sampleRate, seeds, { lo: minStart - start, hi: maxEnd - end }, smooth);
  const loopStart = start + r.shift;
  const loopEnd = end + r.shift;
  const jumps = r.jumps;

  // playable? every piece has room for its fades and lies inside the song
  let seconds = 0;
  for (let k = 0; k < jumps.length; k++) {
    const pieceStart = k === 0 ? loopStart : jumps[k - 1]!.to;
    const pieceEnd = jumps[k]!.from;
    if (pieceEnd - pieceStart < MIN_PIECE_SECONDS || pieceStart < -1e-9 || pieceEnd > duration + 1e-9) return null;
    seconds += pieceEnd - pieceStart;
  }
  seconds -= loopEnd - loopStart;
  if (seconds <= 0) return null;

  const scored: SeamScores[] = jumps.map((j) => tool.scores(j.to, j.from));
  const worst = scored.reduce((w, s) => (s.quality < w.quality ? s : w), scored[0]!);
  const last = path.jumps[path.jumps.length - 1]!;
  return {
    forStart: start,
    forEnd: end,
    smooth,
    shift: r.shift,
    align: r.aligns[r.aligns.length - 1]!,
    loopStart,
    loopEnd,
    jumps,
    before: tool.scores(start, end),
    after: { ...worst, harmony: Math.min(...scored.map((s) => s.harmony ?? 1)) },
    bridge: {
      bars: path.bars,
      seconds,
      from: loopEnd,
      chordChangeAt: beats[Math.min(beats.length - 1, Math.max(0, last.at))]! + r.shift,
      worstHarmony: path.worstHarmony,
      jumps: jumps.length,
    },
  };
}
