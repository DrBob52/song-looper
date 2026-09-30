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

/** Wrap one file in an uncompressed ZIP archive. */
export async function zipSingleFile(filename: string, data: Blob, modified = new Date()): Promise<Blob> {
  if (data.size >= 0xffffffff) throw new Error('File is too large to zip (over 4 GB).');
  const name = new TextEncoder().encode(filename);
  const crc = await crc32Blob(data);
  const size = data.size;
  const { time, date } = dosDateTime(modified);
  const UTF8_FLAG = 0x0800;

  const local = new Uint8Array(30 + name.length);
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

  const central = new Uint8Array(46 + name.length);
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

  const centralOffset = local.length + size;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, centralOffset, true);

  return new Blob([local, data, central, end], { type: 'application/zip' });
}
