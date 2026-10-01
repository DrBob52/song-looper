import type { Plan } from '../model';
import type { RenderClient } from './renderClient';
import type { ChunkSource } from './stream';

/**
 * The extended song of one plan as a `ChunkSource`: chunks are rendered by the render worker (`renderRange`, the same
 * code the export runs) and a few of the latest are kept, so seeking back or pausing and resuming costs nothing.
 */
export class WorkerChunkSource implements ChunkSource {
  private cache = new Map<string, Float32Array[]>();
  private inflight = new Map<string, Promise<Float32Array[]>>();

  constructor(
    private client: Pick<RenderClient, 'renderChunk'>,
    private plan: Plan,
    private crossfadeMs: number,
    readonly totalFrames: number,
    readonly sampleRate: number,
    readonly channels: number,
    private maxCached = 6,
  ) {}

  fetch(start: number, frames: number): Promise<Float32Array[]> {
    const key = `${start}|${frames}`;
    const hit = this.cache.get(key);
    if (hit) {
      // most recently used goes to the back
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = this.client.renderChunk(this.plan, this.crossfadeMs, start, frames).then((data) => {
      this.inflight.delete(key);
      this.cache.set(key, data);
      while (this.cache.size > this.maxCached) this.cache.delete(this.cache.keys().next().value as string);
      return data;
    });
    request.catch(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }
}
