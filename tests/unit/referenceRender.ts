/**
 * The whole-song renderer exactly as it was before `renderRange` existed (a frozen copy of the v1.1 `stitch` and
 * `renderExtended`), kept as the oracle for "a range equals the same slice of the full render".
 */
import { RENDER_CONFIG } from '../../src/audio/config';
import type { FadeWindow, Part, RenderOptions } from '../../src/audio/render';
import { jumpFade, makeMid, regionParts, regionsToSamples, renderedLength } from '../../src/audio/render';
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

/** The full render, the way it was done before ranges. */
export function referenceRenderExtended(buffer: AudioBufferLike, plan: Plan, options: RenderOptions = {}): Float32Array[] {
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
