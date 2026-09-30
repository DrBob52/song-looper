/**
 * Hand-written WAV encoder: RIFF header, `fmt ` chunk (PCM format 1 for 16/24-bit,
 * IEEE float format 3 for 32-bit) and an interleaved `data` chunk.
 */

export type BitDepth = 16 | 24 | 32;

export interface WavOptions {
  bitDepth?: BitDepth;
  /** TPDF dither for 16-bit output (default true). */
  dither?: boolean;
  onProgress?: (fraction: number) => void;
}

export const WAV_MAX_DATA_BYTES = 0xffffffff - 44;

export function bytesPerSample(bitDepth: BitDepth): number {
  return bitDepth / 8;
}

/** Size in bytes of the finished file. */
export function estimateWavSize(frames: number, channels: number, bitDepth: BitDepth): number {
  return 44 + frames * channels * bytesPerSample(bitDepth);
}

/** The 44-byte canonical header. */
export function wavHeader(
  frames: number,
  channels: number,
  sampleRate: number,
  bitDepth: BitDepth,
): Uint8Array {
  const bytesPer = bytesPerSample(bitDepth);
  const dataBytes = frames * channels * bytesPer;
  if (dataBytes > WAV_MAX_DATA_BYTES) {
    throw new Error('This file would be larger than the 4 GB WAV limit. Try a shorter length or 16-bit.');
  }
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1 = PCM, 3 = IEEE float
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPer, true); // byte rate
  v.setUint16(32, channels * bytesPer, true); // block align
  v.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/** Small deterministic PRNG (xorshift32) so dithered output is reproducible. */
function makeRng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const CHUNK_FRAMES = 1 << 18;

/** Encode channels to a WAV Blob. Built in chunks so a huge file never needs one giant buffer. */
export function encodeWav(channels: Float32Array[], sampleRate: number, options: WavOptions = {}): Blob {
  const bitDepth = options.bitDepth ?? 16;
  const dither = options.dither ?? true;
  const nCh = channels.length;
  if (nCh === 0) throw new Error('encodeWav: no channels');
  const frames = channels[0]!.length;
  const header = wavHeader(frames, nCh, sampleRate, bitDepth);
  const parts: BlobPart[] = [header as Uint8Array<ArrayBuffer>];
  const rng = makeRng(0x9e3779b9);

  for (let start = 0; start < frames; start += CHUNK_FRAMES) {
    const n = Math.min(CHUNK_FRAMES, frames - start);
    const out = new ArrayBuffer(n * nCh * bytesPerSample(bitDepth));
    const dv = new DataView(out);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) {
        const x = channels[c]![start + i]!;
        if (bitDepth === 16) {
          let s = x * 32767;
          if (dither) s += rng() - rng();
          s = Math.round(s);
          dv.setInt16(o, s > 32767 ? 32767 : s < -32768 ? -32768 : s, true);
          o += 2;
        } else if (bitDepth === 24) {
          let s = Math.round(x * 8388607);
          s = s > 8388607 ? 8388607 : s < -8388608 ? -8388608 : s;
          dv.setUint8(o, s & 0xff);
          dv.setUint8(o + 1, (s >> 8) & 0xff);
          dv.setUint8(o + 2, (s >> 16) & 0xff);
          o += 3;
        } else {
          dv.setFloat32(o, x, true);
          o += 4;
        }
      }
    }
    parts.push(out);
    options.onProgress?.((start + n) / frames);
  }
  return new Blob(parts, { type: 'audio/wav' });
}

/** Encode straight to bytes (for tests and small fixtures). */
export async function encodeWavBytes(
  channels: Float32Array[],
  sampleRate: number,
  options: WavOptions = {},
): Promise<Uint8Array> {
  const blob = encodeWav(channels, sampleRate, options);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
