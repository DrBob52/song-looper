/**
 * Collects the pieces of a big file as a Blob without holding them in memory: every `flushBytes` of pieces are
 * wrapped in a Blob (which the browser may keep on disk) and the buffers are let go. The finished file is a Blob of
 * Blobs, so even a multi-gigabyte WAV never exists as one allocation.
 */
export class BlobAssembler {
  private blobs: Blob[] = [];
  private pending: BlobPart[] = [];
  private pendingBytes = 0;
  /** Bytes added so far. */
  size = 0;

  constructor(private flushBytes = 64 * 1024 * 1024) {}

  add(part: ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    const n = part.byteLength;
    this.pending.push(part);
    this.pendingBytes += n;
    this.size += n;
    if (this.pendingBytes >= this.flushBytes) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** The finished file; the assembler is empty afterwards. */
  finish(type: string): Blob {
    this.flush();
    const blob = new Blob(this.blobs, { type });
    this.blobs = [];
    this.size = 0;
    return blob;
  }

  /** Throw everything away (a cancelled export). */
  discard(): void {
    this.blobs = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.size = 0;
  }
}
