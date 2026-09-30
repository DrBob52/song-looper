import type { Plan } from '../model';
import type { ExportStage, StretchParams, WorkerRequest, WorkerResponse } from './renderProtocol';
import type { AudioBufferLike } from './types';
import type { BitDepth } from './wav';

export class SupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'SupersededError';
  }
}

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  onProgress?: (stage: ExportStage, pct: number) => void;
  kind: 'render' | 'export';
}

/** Main-thread handle for the render/export worker. */
export class RenderClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Render worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (msg.type === 'progress') {
      p?.onProgress?.(msg.stage, msg.pct);
      return;
    }
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else if (msg.type === 'rendered') (p.resolve as (v: unknown) => void)({ channels: msg.channels, sampleRate: msg.sampleRate });
    else (p.resolve as (v: unknown) => void)(msg.blob);
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  /** Send the decoded song to the worker (copied once; reused by every render). */
  setSource(buffer: AudioBufferLike): void {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    this.post({ type: 'setSource', channels, sampleRate: buffer.sampleRate });
  }

  /** Render the extended song. A newer call supersedes (rejects) an older pending render. */
  render(plan: Plan, crossfadeMs: number): Promise<{ channels: Float32Array[]; sampleRate: number }> {
    const id = this.nextId++;
    for (const [pid, p] of this.pending) {
      if (p.kind === 'render' && pid < id) {
        this.pending.delete(pid);
        p.reject(new SupersededError());
      }
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, kind: 'render' });
      this.post({ type: 'render', id, plan, crossfadeMs });
    });
  }

  /** Render, optionally stretch, and encode a WAV file off the main thread. */
  export(
    plan: Plan,
    opts: { crossfadeMs: number; bitDepth: BitDepth; stretch: StretchParams | null },
    onProgress: (stage: ExportStage, pct: number) => void,
  ): Promise<Blob> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, onProgress, kind: 'export' });
      this.post({ type: 'export', id, plan, ...opts });
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
  }
}
