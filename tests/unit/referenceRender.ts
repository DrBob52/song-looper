/**
 * The whole-song renderer exactly as it was before `renderRange` existed (a frozen copy of the v1.1 `stitch` and
 * `renderExtended`), kept as the oracle for "a range equals the same slice of the full render".
 */
import { RENDER_CONFIG } from '../../src/audio/config';
import type { FadeWindow, Part, RenderOptions } from '../../src/audio/render';
import { CUT_FADE_SECONDS, PLAIN_JUMP, jumpFade, makeMid, planExtras, regionParts, regionsToSamples, renderedLength } from '../../src/audio/render';
import type { SampleRegion } from '../../src/audio/render';
import type { Plan } from '../../src/model';
import type { AudioBufferLike } from '../../src/audio/types';

export interface Stitched {
  channels: Float32Array[];
  partStarts: number[];
}

export function referenceStitch(buffer: AudioBufferLike, parts: Part[], options: RenderOptions = {}): Stitched {
  const length = buffer.length;
  const mid = makeMid(buffer);
  const partStarts: number[] = [];
  let total = 0;
  for (const p of parts) {
    partStarts.push(total);
    total += p.end - p.start;
  }
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
  }
  return { channels, partStarts };
}

/**
 * The full render of a plan with cuts and/or an ending, worked out a different way from `PlanParts`: walk the song from
 * start to end, laying loops and cuts in source order, and decide that a part is entered by a jump simply because it does
 * not start where the part before it ended. The start of the song is faded in when the first part does not begin at
 * sample 0 (a cut took the intro), the end faded out when the last part does not end at the song's end.
 */
export function referenceRenderWithCuts(buffer: AudioBufferLike, plan: Plan, options: RenderOptions = {}): Float32Array[] {
  const length = buffer.length;
  const sr = buffer.sampleRate;
  const regions = regionsToSamples(buffer, plan, options);
  const extras = planExtras(buffer, plan, options);
  type Item = { kind: 'loop'; start: number; end: number; r: SampleRegion } | { kind: 'cut'; start: number; end: number };
  const items: Item[] = [
    ...regions.map((r): Item => ({ kind: 'loop', start: r.start, end: r.end, r })),
    ...(extras.cuts ?? []).map((c): Item => ({ kind: 'cut', start: c.start, end: c.end })),
  ].sort((a, b) => a.start - b.start);
  const parts: Part[] = [];
  let pos = 0;
  const lastEnd = (): number | undefined => (parts.length ? parts[parts.length - 1]!.end : undefined);
  const plain = (start: number, end: number): void => {
    if (end <= start) return;
    const prev = lastEnd();
    parts.push(prev !== undefined && prev !== start ? { start, end, jump: PLAIN_JUMP } : { start, end });
  };
  for (const item of items) {
    if (item.kind === 'cut') {
      plain(pos, item.start);
      pos = Math.max(pos, item.end);
      continue;
    }
    plain(pos, item.start);
    const r = item.r;
    const prev = lastEnd();
    const enter = prev !== undefined && prev !== r.start;
    const back = r.jumps[r.jumps.length - 1]!;
    for (let k = 0; k < r.repeats - 1; k++) {
      r.pieces.forEach((p, i) => {
        const via = i === 0 ? (k === 0 ? (enter ? PLAIN_JUMP : undefined) : back) : r.jumps[i - 1]!;
        parts.push({ start: p.start, end: p.end, jump: via && { fadeMs: via.fadeMs, gain: via.gain, ramp: via.ramp } });
      });
    }
    parts.push({ start: r.start, end: r.end, jump: r.repeats > 1 ? { fadeMs: back.fadeMs, gain: back.gain, ramp: back.ramp } : enter ? PLAIN_JUMP : undefined });
    pos = r.end;
  }
  plain(pos, length);
  const natural = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  const total = extras.endFrames !== undefined && extras.endFrames < natural ? extras.endFrames : natural;
  const channels = referenceStitch(buffer, parts, options).channels.map((c) => c.slice(0, total));
  const cutFade = Math.round(CUT_FADE_SECONDS * sr);
  const leading = parts.length > 0 && parts[0]!.start !== 0;
  const trailing = parts.length > 0 && parts[parts.length - 1]!.end !== length;
  const trimmed = total < natural;
  const out = Math.min(total, extras.fadeOutFrames && extras.fadeOutFrames > 0 ? extras.fadeOutFrames : trailing && !trimmed ? cutFade : 0);
  const inn = leading ? Math.min(total, cutFade) : 0;
  // the fade-out ends at exactly 0 on the last sample, the fade-in starts at exactly 0 on the first
  const outGain = (i: number, f: number): number => (i >= f - 1 ? 0 : Math.cos((Math.PI / 2) * (i / (f - 1))));
  for (const c of channels) {
    for (let q = 0; q < inn; q++) c[q] = c[q]! * outGain(inn - 1 - q, inn);
    for (let q = total - out; q < total; q++) c[q] = c[q]! * outGain(q - (total - out), out);
  }
  return channels;
}

/** The full render, the way it was done before ranges. */
export function referenceRenderExtended(buffer: AudioBufferLike, plan: Plan, options: RenderOptions = {}): Float32Array[] {
  if (plan.cuts?.length || plan.ending) return referenceRenderWithCuts(buffer, plan, options);
  const length = buffer.length;
  const regions = regionsToSamples(buffer, plan, options);
  if (renderedLength(regions, length) > RENDER_CONFIG.maxInMemoryFrames) throw new Error('too long for the reference renderer');
  const parts: Part[] = [];
  let cursor = 0;
  for (const r of regions) {
    parts.push(...regionParts(r, cursor));
    cursor = r.end;
  }
  parts.push({ start: cursor, end: length });
  return referenceStitch(buffer, parts, options).channels;
}
