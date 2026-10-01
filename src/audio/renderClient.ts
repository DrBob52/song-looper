import type { Plan } from '../model';
import { BlobAssembler } from './blobAssembler';
import type { StretchParams, WorkerRequest, WorkerResponse } from './renderProtocol';
import type { AudioBufferLike } from './types';
import type { BitDepth } from './wav';

export class SupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'SupersededError';
  }
}

/** The user pressed Cancel: the worker was stopped and the pieces written so far were thrown away. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelledError';
  }
}

export interface ExportProgress {
  /** 0..1 of the extended song rendered. */
  fraction: number;
  framesDone: number;
  framesTotal: number;
}

export interface ExportOutput {
  blob: Blob;
  /** Frames in the file. */
  frames: number;
  bytes: number;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  kind: 'chunk' | 'export';
  /** Export only. */
  onProgress?: (p: ExportProgress) => void;
  assembler?: BlobAssembler;
  header?: Uint8Array<ArrayBuffer>;
}

/** Main-thread handle for the render/export worker. */
export class RenderClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private source: AudioBufferLike | null = null;

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Render worker crashed');
      for (const p of this.pending.values()) {
        p.assembler?.discard();
        p.reject(err);
      }
      this.pending.clear();
    };
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.onProgress?.({ fraction: msg.fraction, framesDone: msg.done, framesTotal: msg.total });
    } else if (msg.type === 'header') {
      p.header = new Uint8Array(msg.bytes);
    } else if (msg.type === 'data') {
      p.assembler?.add(msg.bytes);
      this.post({ type: 'ack', id: msg.id, bytes: msg.bytes.byteLength });
    } else {
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        p.assembler?.discard();
        p.reject(new Error(msg.message));
      } else if (msg.type === 'chunk') {
        (p.resolve as (v: unknown) => void)(msg.channels);
      } else if (msg.type === 'exported') {
        const asm = p.assembler!;
        const header = p.header;
        if (!header) {
          p.reject(new Error('The export finished without a header.'));
          return;
        }
        const body = asm.finish('audio/wav');
        const blob = new Blob([header, body], { type: 'audio/wav' });
        (p.resolve as (v: ExportOutput) => void)({ blob, frames: msg.frames, bytes: msg.bytes });
      }
    }
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  /** Send the decoded song to the worker (copied once; reused by every render). */
  setSource(buffer: AudioBufferLike): void {
    this.source = buffer;
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    this.post({ type: 'setSource', channels, sampleRate: buffer.sampleRate });
  }

  /** Frames [start, start + frames) of the extended song, rendered in the worker (the live preview's chunks). */
  renderChunk(plan: Plan, crossfadeMs: number, start: number, frames: number): Promise<Float32Array[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, kind: 'chunk' });
      this.post({ type: 'chunk', id, plan, crossfadeMs, start, frames });
    });
  }

  /**
   * Render the extended song piece by piece in the worker, optionally stretch it, and encode a WAV file. The pieces
   * are collected as a Blob of Blobs, so the file never exists as one allocation.
   */
  export(
    plan: Plan,
    opts: { crossfadeMs: number; bitDepth: BitDepth; stretch: StretchParams | null; chunkSeconds?: number },
    onProgress: (p: ExportProgress) => void,
  ): Promise<ExportOutput> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
        onProgress,
        kind: 'export',
        assembler: new BlobAssembler(),
      });
      this.post({ type: 'export', id, plan, ...opts });
    });
  }

  /** Is an export running? */
  get exporting(): boolean {
    for (const p of this.pending.values()) if (p.kind === 'export') return true;
    return false;
  }

  /**
   * Stop a running export: the worker is terminated (at once, even in the middle of a piece), the pieces written so
   * far are discarded, and a fresh worker takes its place with the song loaded again.
   */
  cancelExport(): void {
    let any = false;
    for (const [id, p] of this.pending) {
      if (p.kind !== 'export') continue;
      any = true;
      p.assembler?.discard();
      this.pending.delete(id);
      p.reject(new ExportCancelledError());
    }
    if (!any) return;
    this.worker.terminate();
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new SupersededError());
    }
    this.spawn();
    if (this.source) this.setSource(this.source);
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) {
      p.assembler?.discard();
      p.reject(new Error('disposed'));
    }
    this.pending.clear();
  }
}
