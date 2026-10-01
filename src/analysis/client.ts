import type { AnalysisRequest, AnalysisResponse } from './protocol';
import type { Analysis, AnalysisStage, AnalysisUpdate, SeamReport, SeamRequest } from './types';

export class AnalysisSupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'AnalysisSupersededError';
  }
}

interface Pending {
  resolve: (a: never) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: AnalysisStage, pct: number) => void;
  /** A seam report of this scope; a newer report of the same scope supersedes it. */
  seam?: string;
}

/** Main-thread handle for the analysis worker. */
export class AnalysisClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<AnalysisResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.onProgress?.(msg.stage, msg.pct);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.analysis as never);
        else if (msg.type === 'seamReport') p.resolve(msg.reports as never);
        else p.reject(new Error(msg.message));
      }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Analysis worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  /** Reject every pending request (a new analysis makes the old seam reports stale too). */
  private supersedeAll(): void {
    for (const p of this.pending.values()) p.reject(new AnalysisSupersededError());
    this.pending.clear();
  }

  private send(msg: AnalysisRequest, p: Pending, transfer: Transferable[] = []): Promise<Analysis> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { ...p, resolve: resolve as (a: never) => void, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  /**
   * Seam reports for some loops of the analysed song. A newer call of the same `scope` supersedes an older pending
   * one (each call covers all the loops of its scope, so the newest is the one that matters); a new analysis
   * supersedes every report.
   */
  seamReport(regions: SeamRequest[], scope = 'loops'): Promise<SeamReport[]> {
    for (const [pid, p] of this.pending) {
      if (p.seam === scope) {
        this.pending.delete(pid);
        p.reject(new AnalysisSupersededError());
      }
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (a: never) => void, reject, seam: scope });
      this.worker.postMessage({ type: 'seamReport', id, regions } satisfies AnalysisRequest);
    });
  }

  /** Analyse 22.05 kHz mono samples. The array is transferred to the worker. */
  analyze(
    samples: Float32Array,
    sampleRate: number,
    beatsPerBar: number,
    onProgress?: (stage: AnalysisStage, pct: number) => void,
  ): Promise<Analysis> {
    this.supersedeAll();
    const id = this.nextId++;
    return this.send(
      { type: 'analyze', id, samples, sampleRate, beatsPerBar },
      { onProgress, resolve: () => undefined, reject: () => undefined },
      [samples.buffer],
    );
  }

  /** Re-run from the changed stage using the worker's cached data. */
  update(change: AnalysisUpdate, onProgress?: (stage: AnalysisStage, pct: number) => void): Promise<Analysis> {
    this.supersedeAll();
    const id = this.nextId++;
    return this.send(
      { type: 'update', id, change },
      { onProgress, resolve: () => undefined, reject: () => undefined },
    );
  }

  /** Drop any in-flight request (for example when a new song loads). */
  cancel(): void {
    this.supersedeAll();
  }

  dispose(): void {
    this.worker.terminate();
    this.supersedeAll();
  }
}
