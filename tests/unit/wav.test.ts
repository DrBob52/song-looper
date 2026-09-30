import { describe, expect, it } from 'vitest';
import { encodeWav, encodeWavBytes, estimateWavSize, wavHeader } from '../../src/audio/wav';

const str = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

describe('wavHeader', () => {
  it.each([
    [16, 1, 2],
    [24, 1, 3],
    [32, 3, 4],
  ] as const)('writes correct fields for %i-bit', (bits, format, bytes) => {
    const frames = 1000;
    const ch = 2;
    const rate = 44100;
    const h = wavHeader(frames, ch, rate, bits);
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    expect(h.length).toBe(44);
    expect(str(h, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + frames * ch * bytes);
    expect(str(h, 8, 4)).toBe('WAVE');
    expect(str(h, 12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(format);
    expect(v.getUint16(22, true)).toBe(ch);
    expect(v.getUint32(24, true)).toBe(rate);
    expect(v.getUint32(28, true)).toBe(rate * ch * bytes);
    expect(v.getUint16(32, true)).toBe(ch * bytes);
    expect(v.getUint16(34, true)).toBe(bits);
    expect(str(h, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(frames * ch * bytes);
  });

  it('refuses files over the 4 GB limit', () => {
    expect(() => wavHeader(2 ** 31, 2, 44100, 32)).toThrow(/4 GB/);
  });

  it('estimates size', () => {
    expect(estimateWavSize(1000, 2, 24)).toBe(44 + 6000);
  });
});

describe('encodeWav', () => {
  const ramp = Float32Array.from({ length: 64 }, (_, i) => (i / 63) * 2 - 1);

  it('produces a file of the right length for each bit depth', async () => {
    for (const [bits, bytes] of [[16, 2], [24, 3], [32, 4]] as const) {
      const out = await encodeWavBytes([ramp, ramp], 8000, { bitDepth: bits });
      expect(out.length).toBe(44 + 64 * 2 * bytes);
    }
  });

  it('round-trips 16-bit samples (no dither) and interleaves channels', async () => {
    const l = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const r = Float32Array.from([0.25, -0.25, 0, 0.75, -0.75]);
    const out = await encodeWavBytes([l, r], 8000, { bitDepth: 16, dither: false });
    const v = new DataView(out.buffer, out.byteOffset + 44);
    for (let i = 0; i < 5; i++) {
      expect(v.getInt16(i * 4, true) / 32767).toBeCloseTo(l[i]!, 4);
      expect(v.getInt16(i * 4 + 2, true) / 32767).toBeCloseTo(r[i]!, 4);
    }
  });

  it('round-trips 24-bit and 32-bit float', async () => {
    const x = Float32Array.from([0, 0.123456, -0.654321, 0.999, -1]);
    const o24 = await encodeWavBytes([x], 8000, { bitDepth: 24 });
    const v24 = new DataView(o24.buffer, o24.byteOffset + 44);
    for (let i = 0; i < x.length; i++) {
      const raw = v24.getUint8(i * 3) | (v24.getUint8(i * 3 + 1) << 8) | (v24.getInt8(i * 3 + 2) << 16);
      expect(raw / 8388607).toBeCloseTo(x[i]!, 6);
    }
    const o32 = await encodeWavBytes([x], 8000, { bitDepth: 32 });
    const v32 = new DataView(o32.buffer, o32.byteOffset + 44);
    for (let i = 0; i < x.length; i++) expect(v32.getFloat32(i * 4, true)).toBe(x[i]);
  });

  it('clips out-of-range samples instead of wrapping', async () => {
    const x = Float32Array.from([2, -2, 1.5]);
    const o16 = await encodeWavBytes([x], 8000, { bitDepth: 16, dither: false });
    const v = new DataView(o16.buffer, o16.byteOffset + 44);
    expect(v.getInt16(0, true)).toBe(32767);
    expect(v.getInt16(2, true)).toBe(-32768);
    const o24 = await encodeWavBytes([x], 8000, { bitDepth: 24 });
    const v24 = new DataView(o24.buffer, o24.byteOffset + 44);
    expect(v24.getInt8(2)).toBe(0x7f);
    expect(v24.getInt8(5)).toBe(-128);
  });

  it('dithers 16-bit output within about one LSB and keeps the mean', async () => {
    const x = new Float32Array(20000).fill(0.25);
    const out = await encodeWavBytes([x], 8000, { bitDepth: 16, dither: true });
    const v = new DataView(out.buffer, out.byteOffset + 44);
    let sum = 0;
    let maxDev = 0;
    const target = 0.25 * 32767;
    for (let i = 0; i < x.length; i++) {
      const s = v.getInt16(i * 2, true);
      sum += s;
      maxDev = Math.max(maxDev, Math.abs(s - target));
    }
    expect(maxDev).toBeLessThanOrEqual(2);
    expect(sum / x.length).toBeCloseTo(target, 0);
    // not all identical values: dither is actually applied
    const distinct = new Set<number>();
    for (let i = 0; i < 200; i++) distinct.add(v.getInt16(i * 2, true));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('reports progress and returns an audio/wav blob', () => {
    const steps: number[] = [];
    const blob = encodeWav([ramp], 8000, { onProgress: (f) => steps.push(f) });
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 64 * 2);
    expect(steps[steps.length - 1]).toBe(1);
  });
});
