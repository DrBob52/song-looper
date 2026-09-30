import { describe, expect, it } from 'vitest';
import { sniffSampleRate } from '../../src/audio/sniff';
import { wavHeader } from '../../src/audio/wav';
import { computePeaks } from '../../src/audio/decode';
import { makeBuffer } from '../../src/audio/types';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const box = (type: string, ...payload: number[][]): number[] => {
  const body = payload.flat();
  return [...u32be(8 + body.length), ...ascii(type), ...body];
};

describe('sniffSampleRate', () => {
  it('reads WAV', () => {
    expect(sniffSampleRate(wavHeader(100, 2, 48000, 16))).toBe(48000);
    expect(sniffSampleRate(wavHeader(100, 1, 22050, 24))).toBe(22050);
  });

  it('reads FLAC STREAMINFO', () => {
    const b = new Uint8Array(42);
    b.set(ascii('fLaC'), 0);
    b[4] = 0x80;
    b[7] = 34;
    // 44100 Hz = 0x0AC44 in 20 bits
    b[18] = 0x0a;
    b[19] = 0xc4;
    b[20] = 0x42;
    expect(sniffSampleRate(b)).toBe(44100);
  });

  it('reads Ogg Vorbis and Opus', () => {
    const page = (payload: number[]): Uint8Array => {
      const head = new Array(27).fill(0);
      head.splice(0, 4, ...ascii('OggS'));
      head[26] = 1;
      return Uint8Array.from([...head, payload.length, ...payload]);
    };
    const vorbis = [1, ...ascii('vorbis'), ...u32le(0), 2, ...u32le(32000)];
    expect(sniffSampleRate(page(vorbis))).toBe(32000);
    expect(sniffSampleRate(page([...ascii('OpusHead'), 1, 2]))).toBe(48000);
  });

  it('reads MP3 frame headers, skipping ID3', () => {
    const id3 = [...ascii('ID3'), 4, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4];
    const frame = (rateBits: number): number[] => [0xff, 0xfb, (rateBits << 2) | 0x90 & 0xf3, 0x00];
    expect(sniffSampleRate(Uint8Array.from([...id3, ...frame(0), 0, 0]))).toBe(44100);
    expect(sniffSampleRate(Uint8Array.from([...frame(1), 0, 0, 0, 0]))).toBe(48000);
    // MPEG-2 layer III at 24 kHz: 0xFF 0xF3
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xf3, 0x14, 0, 0, 0]))).toBe(24000);
  });

  it('reads MP4 audio track timescale', () => {
    const mdhd = box('mdhd', [0, 0, 0, 0], u32be(0), u32be(0), u32be(44100), u32be(0), [0, 0, 0, 0]);
    const hdlr = box('hdlr', [0, 0, 0, 0], u32be(0), ascii('soun'), u32be(0), u32be(0), u32be(0), [0]);
    const videoMdhd = box('mdhd', [0, 0, 0, 0], u32be(0), u32be(0), u32be(90000), u32be(0), [0, 0, 0, 0]);
    const videoHdlr = box('hdlr', [0, 0, 0, 0], u32be(0), ascii('vide'), u32be(0), u32be(0), u32be(0), [0]);
    const trak = (m: number[], hd: number[]): number[] => box('trak', box('mdia', m, hd));
    const file = [
      ...box('ftyp', ascii('M4A '), u32be(0)),
      ...box('moov', trak(videoMdhd, videoHdlr), trak(mdhd, hdlr)),
    ];
    expect(sniffSampleRate(Uint8Array.from(file))).toBe(44100);
  });

  it('returns null for unknown data', () => {
    expect(sniffSampleRate(new Uint8Array(100))).toBeNull();
    expect(sniffSampleRate(new Uint8Array(0))).toBeNull();
  });
});

describe('computePeaks', () => {
  it('returns max-abs across channels', () => {
    const l = new Float32Array(1000);
    const r = new Float32Array(1000);
    l[10] = 0.5;
    r[10] = -0.8;
    r[900] = 0.3;
    const peaks = computePeaks(makeBuffer([l, r], 100), 10); // 10 s -> 100 peaks
    expect(peaks.length).toBe(100);
    expect(Math.max(...peaks)).toBeCloseTo(0.8, 5);
    expect(peaks[1]).toBeCloseTo(0.8, 5);
    expect(peaks[90]).toBeCloseTo(0.3, 5);
    expect(peaks[50]).toBe(0);
  });
});
