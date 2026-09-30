/**
 * Best-effort sample-rate sniffing from container headers.
 *
 * `decodeAudioData` resamples to the rate of the context that decodes it, so to
 * render and export at the file's native rate we need to know that rate before
 * decoding. This reads it from the WAV, FLAC, Ogg (Vorbis/Opus), MP3 and MP4
 * headers. Returns null when the format is not recognised.
 */
export function sniffSampleRate(bytes: Uint8Array): number | null {
  try {
    return (
      sniffWav(bytes) ?? sniffFlac(bytes) ?? sniffOgg(bytes) ?? sniffMp4(bytes) ?? sniffMp3(bytes)
    );
  } catch {
    return null;
  }
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i++) s += String.fromCharCode(b[off + i]!);
  return s;
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function sniffWav(b: Uint8Array): number | null {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = ascii(b, pos, 4);
    const size = u32le(b, pos + 4);
    if (id === 'fmt ') return u32le(b, pos + 12);
    pos += 8 + size + (size & 1);
  }
  return null;
}

function sniffFlac(b: Uint8Array): number | null {
  if (ascii(b, 0, 4) !== 'fLaC' || b.length < 21) return null;
  // STREAMINFO starts at byte 8; the 20-bit sample rate is at byte offset 10 within it.
  return (b[18]! << 12) | (b[19]! << 4) | (b[20]! >> 4);
}

function sniffOgg(b: Uint8Array): number | null {
  if (ascii(b, 0, 4) !== 'OggS') return null;
  const segments = b[26]!;
  const payload = 27 + segments;
  if (b[payload] === 0x01 && ascii(b, payload + 1, 6) === 'vorbis') {
    return u32le(b, payload + 12);
  }
  if (ascii(b, payload, 8) === 'OpusHead') return 48000;
  return null;
}

function sniffMp3(b: Uint8Array): number | null {
  let pos = 0;
  if (ascii(b, 0, 3) === 'ID3') {
    const size = (b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!;
    pos = 10 + size;
  }
  const limit = Math.min(b.length - 4, pos + 65536);
  for (; pos < limit; pos++) {
    if (b[pos] !== 0xff || (b[pos + 1]! & 0xe0) !== 0xe0) continue;
    const versionBits = (b[pos + 1]! >> 3) & 3;
    const layerBits = (b[pos + 1]! >> 1) & 3;
    const rateIdx = (b[pos + 2]! >> 2) & 3;
    if (versionBits === 1 || layerBits === 0 || rateIdx === 3) continue;
    const table =
      versionBits === 3 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    return table[rateIdx]!;
  }
  return null;
}

/** Walk MP4 boxes looking for an audio track's `mdhd` timescale. */
function sniffMp4(b: Uint8Array): number | null {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null;
  const CONTAINERS = new Set(['moov', 'trak', 'mdia']);
  let found: number | null = null;

  const walk = (start: number, end: number, ctx: { timescale: number | null; audio: boolean }): void => {
    let pos = start;
    while (pos + 8 <= end && found === null) {
      let size = u32be(b, pos);
      const type = ascii(b, pos + 4, 4);
      let header = 8;
      if (size === 1) {
        // 64-bit size: only handle the low 32 bits
        size = u32be(b, pos + 12);
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header) return;
      const bodyStart = pos + header;
      const bodyEnd = Math.min(end, pos + size);
      if (type === 'trak') {
        const trackCtx = { timescale: null as number | null, audio: false };
        walk(bodyStart, bodyEnd, trackCtx);
        if (trackCtx.audio && trackCtx.timescale) found = trackCtx.timescale;
      } else if (CONTAINERS.has(type)) {
        walk(bodyStart, bodyEnd, ctx);
      } else if (type === 'mdhd') {
        const version = b[bodyStart]!;
        ctx.timescale = u32be(b, bodyStart + (version === 1 ? 20 : 12));
      } else if (type === 'hdlr') {
        ctx.audio = ascii(b, bodyStart + 8, 4) === 'soun';
      }
      pos += size;
    }
  };
  walk(0, b.length, { timescale: null, audio: false });
  return found;
}

/** True when the bytes start with an ISO-BMFF/QuickTime `ftyp` box (m4a, mp4, mov). */
export function isMp4(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 4, 4) === 'ftyp';
}

/** True for a raw ADTS AAC stream (.aac), optionally behind an ID3 tag. */
export function isAdts(b: Uint8Array): boolean {
  let pos = 0;
  if (ascii(b, 0, 3) === 'ID3' && b.length > 10) {
    pos = 10 + ((b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!);
  }
  return pos + 1 < b.length && b[pos] === 0xff && (b[pos + 1]! & 0xf6) === 0xf0;
}

/**
 * The sample-entry code of the first audio track in an MP4 (`mp4a` for AAC,
 * `alac` for Apple Lossless, `enca`/`drms` for copy-protected audio), or null.
 */
export function mp4AudioCodec(b: Uint8Array): string | null {
  if (!isMp4(b)) return null;
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  let found: string | null = null;
  try {
    const walk = (start: number, end: number, ctx: { audio: boolean; codec: string | null }): void => {
      let pos = start;
      while (pos + 8 <= end && found === null) {
        let size = u32be(b, pos);
        const type = ascii(b, pos + 4, 4);
        let header = 8;
        if (size === 1) {
          size = u32be(b, pos + 12);
          header = 16;
        } else if (size === 0) {
          size = end - pos;
        }
        if (size < header) return;
        const bodyStart = pos + header;
        const bodyEnd = Math.min(end, pos + size);
        if (type === 'trak') {
          const trackCtx = { audio: false, codec: null as string | null };
          walk(bodyStart, bodyEnd, trackCtx);
          if (trackCtx.audio && trackCtx.codec) found = trackCtx.codec;
        } else if (CONTAINERS.has(type)) {
          walk(bodyStart, bodyEnd, ctx);
        } else if (type === 'hdlr') {
          ctx.audio = ascii(b, bodyStart + 8, 4) === 'soun';
        } else if (type === 'stsd') {
          // version/flags (4) + entry count (4), then the first entry's size and type
          if (bodyStart + 16 <= bodyEnd) ctx.codec = ascii(b, bodyStart + 12, 4);
        }
        pos += size;
      }
    };
    walk(0, b.length, { audio: false, codec: null });
  } catch {
    return null;
  }
  return found;
}
