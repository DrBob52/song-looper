// Minimal single-file ZIP writer (STORE method, no compression).
// Used when the app runs inside a claude.ai artifact, whose save dialog
// accepts .zip but not .wav. The WAV bytes are never copied: the output
// Blob is [local header, original Blob, central directory, end record].

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function crc32Blob(blob: Blob, chunkBytes = 8 * 1024 * 1024): Promise<number> {
  let crc = 0;
  for (let off = 0; off < blob.size; off += chunkBytes) {
    const buf = await blob.slice(off, off + chunkBytes).arrayBuffer();
    crc = crc32Update(crc, new Uint8Array(buf));
  }
  return crc;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Where the parts of a single-file stored zip sit, for a file of `size` bytes whose name takes `nameBytes` bytes. */
export interface ZipLayout {
  localLength: number;
  centralOffset: number;
  centralLength: number;
  endLength: number;
  /** Size of the whole archive. */
  total: number;
}

/**
 * The zip's header math, with no data: every size and offset in it is a 32-bit field (no zip64 here), so a file that
 * does not leave room for the headers is refused. Throws when something would not fit.
 */
export function zipLayout(nameBytes: number, size: number): ZipLayout {
  if (nameBytes > 0xffff) throw new Error('The file name is too long for a zip.');
  const localLength = 30 + nameBytes;
  const centralOffset = localLength + size;
  const centralLength = 46 + nameBytes;
  const endLength = 22;
  // 0xffffffff in a 32-bit field means "zip64", which this writer does not do: sizes and offsets must stay below it
  if (size >= 0xffffffff || centralOffset >= 0xffffffff) throw new Error('File is too large to zip (over 4 GB).');
  return { localLength, centralOffset, centralLength, endLength, total: centralOffset + centralLength + endLength };
}

export interface ZipParts {
  local: Uint8Array<ArrayBuffer>;
  central: Uint8Array<ArrayBuffer>;
  end: Uint8Array<ArrayBuffer>;
  layout: ZipLayout;
}

/** The three small pieces around the file: local header, central directory, end record. */
export function zipParts(filename: string, size: number, crc: number, modified = new Date()): ZipParts {
  const name = new TextEncoder().encode(filename);
  const layout = zipLayout(name.length, size);
  const { time, date } = dosDateTime(modified);
  const UTF8_FLAG = 0x0800;

  const local = new Uint8Array(layout.localLength);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true); // version needed
  lv.setUint16(6, UTF8_FLAG, true);
  lv.setUint16(8, 0, true); // method: store
  lv.setUint16(10, time, true);
  lv.setUint16(12, date, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, size, true);
  lv.setUint32(22, size, true);
  lv.setUint16(26, name.length, true);
  lv.setUint16(28, 0, true);
  local.set(name, 30);

  const central = new Uint8Array(layout.centralLength);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true); // version made by
  cv.setUint16(6, 20, true); // version needed
  cv.setUint16(8, UTF8_FLAG, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, time, true);
  cv.setUint16(14, date, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, size, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, name.length, true);
  // extra len, comment len, disk no, internal attrs, external attrs: all 0
  cv.setUint32(42, 0, true); // local header offset
  central.set(name, 46);

  const end = new Uint8Array(layout.endLength);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, layout.centralLength, true);
  ev.setUint32(16, layout.centralOffset, true);
  return { local, central, end, layout };
}

/** Wrap one file in an uncompressed ZIP archive. The file's bytes are not copied: the result is a Blob of Blobs. */
export async function zipSingleFile(filename: string, data: Blob, modified = new Date()): Promise<Blob> {
  // refuse before spending time on the checksum of something that cannot be zipped
  zipLayout(new TextEncoder().encode(filename).length, data.size);
  const crc = await crc32Blob(data);
  const { local, central, end } = zipParts(filename, data.size, crc, modified);
  return new Blob([local, data, central, end], { type: 'application/zip' });
}
