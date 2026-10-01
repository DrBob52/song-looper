import { describe, expect, it } from 'vitest';
import { crc32Update, zipLayout, zipParts, zipSingleFile } from '../../src/audio/zip';
import { UINT32_MAX, WAV_ZIP_MARGIN, maxWavFrames, wavHeader } from '../../src/audio/wav';

const enc = new TextEncoder();

describe('crc32Update', () => {
  it('matches known CRC-32 values', () => {
    expect(crc32Update(0, enc.encode(''))).toBe(0);
    expect(crc32Update(0, enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32Update(0, enc.encode('hello'))).toBe(0x3610a686);
  });

  it('gives the same result when fed in chunks', () => {
    const whole = crc32Update(0, enc.encode('hello world'));
    const parts = crc32Update(crc32Update(0, enc.encode('hello ')), enc.encode('world'));
    expect(parts).toBe(whole);
  });
});

describe('zipSingleFile', () => {
  it('writes a valid stored archive around the original bytes', async () => {
    const payload = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
    const name = 'Song (extended).wav';
    const zip = new Uint8Array(await (await zipSingleFile(name, new Blob([payload]), new Date(2026, 8, 30, 12, 0, 0))).arrayBuffer());
    const v = new DataView(zip.buffer);
    const nameLen = enc.encode(name).length;
    const crc = crc32Update(0, payload);

    // Local file header
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(8, true)).toBe(0); // stored
    expect(v.getUint32(14, true)).toBe(crc);
    expect(v.getUint32(18, true)).toBe(payload.length);
    expect(v.getUint32(22, true)).toBe(payload.length);
    expect(v.getUint16(26, true)).toBe(nameLen);
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe(name);
    expect(Array.from(zip.subarray(30 + nameLen, 30 + nameLen + payload.length))).toEqual(Array.from(payload));

    // End of central directory points at the central directory
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(1);
    const cdSize = v.getUint32(eocd + 12, true);
    const cdOffset = v.getUint32(eocd + 16, true);
    expect(cdOffset).toBe(30 + nameLen + payload.length);
    expect(cdSize).toBe(46 + nameLen);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(v.getUint32(cdOffset + 16, true)).toBe(crc);
    expect(v.getUint32(cdOffset + 42, true)).toBe(0);
  });
});

describe('zip header math near the 4 GB cap (SPEC-v1.2.md 2.2)', () => {
  it('a WAV of the largest size the app writes still zips, with a long name', () => {
    for (const [channels, bits] of [[2, 16], [1, 16], [2, 24], [2, 32], [1, 32]] as const) {
      const frames = maxWavFrames(channels, bits);
      const size = 44 + frames * channels * (bits / 8);
      expect(size).toBeLessThanOrEqual(UINT32_MAX - WAV_ZIP_MARGIN);
      // a name of up to ~900 bytes still leaves every offset below the 32-bit limit
      const layout = zipLayout(900, size);
      expect(layout.centralOffset).toBe(30 + 900 + size);
      expect(layout.centralOffset).toBeLessThan(0xffffffff);
      expect(layout.total).toBe(layout.centralOffset + 46 + 900 + 22);
      // the header the WAV carries is the largest the WAV format allows too
      expect(() => wavHeader(frames, channels, 44100, bits)).not.toThrow();
    }
  });

  it('writes the 32-bit fields from a fake size, without any data', () => {
    const size = UINT32_MAX - WAV_ZIP_MARGIN; // the biggest WAV this app writes (16-bit stereo, to the byte)
    const crc = 0xdeadbeef;
    const { local, central, end, layout } = zipParts('Song (extended).wav', size, crc, new Date(2026, 8, 30, 12, 0, 0));
    const nameLen = new TextEncoder().encode('Song (extended).wav').length;
    const lv = new DataView(local.buffer);
    expect(lv.getUint32(14, true)).toBe(crc);
    expect(lv.getUint32(18, true)).toBe(size);
    expect(lv.getUint32(22, true)).toBe(size);
    const cv = new DataView(central.buffer);
    expect(cv.getUint32(20, true)).toBe(size);
    expect(cv.getUint32(24, true)).toBe(size);
    const ev = new DataView(end.buffer);
    expect(ev.getUint32(12, true)).toBe(46 + nameLen);
    expect(ev.getUint32(16, true)).toBe(30 + nameLen + size);
    expect(layout.centralOffset).toBe(30 + nameLen + size);
  });

  it('refuses a file that leaves no room for the headers in 32 bits', () => {
    expect(() => zipLayout(20, 0xffffffff)).toThrow(/4 GB/);
    expect(() => zipLayout(20, 0xffffffff - 40)).toThrow(/4 GB/); // size fits, but the central directory would start past 4 GB
    expect(() => zipLayout(20, 0xffffffff - 51)).not.toThrow();
    expect(() => zipLayout(70000, 100)).toThrow(/name/);
  });

  it('zips a Blob built from many parts (as the piece-by-piece export makes it) around its exact bytes', async () => {
    const pieces = [wavHeader(300, 1, 8000, 16), ...Array.from({ length: 5 }, (_, k) => new Uint8Array(120).map((_, i) => (i * 3 + k) & 0xff))];
    const parts = pieces.map((p) => p as Uint8Array<ArrayBuffer>);
    const nested = new Blob([new Blob(parts.slice(0, 3)), new Blob(parts.slice(3))]);
    const flat = new Uint8Array(await nested.arrayBuffer());
    const zip = new Uint8Array(await (await zipSingleFile('piecewise.wav', nested)).arrayBuffer());
    const v = new DataView(zip.buffer);
    const nameLen = 'piecewise.wav'.length;
    expect(v.getUint32(18, true)).toBe(flat.length);
    expect(v.getUint32(14, true)).toBe(crc32Update(0, flat));
    expect(Array.from(zip.subarray(30 + nameLen, 30 + nameLen + flat.length))).toEqual(Array.from(flat));
    expect(v.getUint32(zip.length - 22 + 16, true)).toBe(30 + nameLen + flat.length);
  });
});
