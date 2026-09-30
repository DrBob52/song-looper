import { describe, expect, it } from 'vitest';
import { crc32Update, zipSingleFile } from '../../src/audio/zip';

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
