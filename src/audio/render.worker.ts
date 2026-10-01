/// Render/export worker: splices the plan, optionally time-stretches/pitch-shifts, and encodes WAV.
import { ExportCancelled, exportWavPieces } from './exportPieces';
import { RangeRenderer, planKey } from './render';
import type { WorkerRequest, WorkerResponse } from './renderProtocol';
import type { AudioBufferLike } from './types';
import { makeBuffer } from './types';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let source: AudioBufferLike | null = null;

/** The layout of the last plan asked for (zero-crossing snaps, seam plans, fades), so each preview chunk costs only its audio. */
let cached: { key: string; renderer: RangeRenderer } | null = null;
function rendererFor(plan: WorkerPlan, crossfadeMs: number): RangeRenderer {
  if (!source) throw new Error('No source audio loaded in the render worker');
  const key = planKey(plan, source.duration, crossfadeMs);
  if (cached?.key !== key) cached = { key, renderer: new RangeRenderer(source, plan, { crossfadeMs }) };
  return cached.renderer;
}
type WorkerPlan = Extract<WorkerRequest, { type: 'chunk' }>['plan'];

/** The export waits when this much data is on its way to the main thread and not yet taken. */
const MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
let inFlight = 0;
let ackWaiter: (() => void) | null = null;

/** Give the event loop a turn about every 40 ms of work (and wait for the main thread to catch up when it lags). */
function makeYielder(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    while (inFlight > MAX_IN_FLIGHT_BYTES) await new Promise<void>((resolve) => (ackWaiter = resolve));
    if (performance.now() - last < 40) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = performance.now();
  };
}

async function runExport(msg: Extract<WorkerRequest, { type: 'export' }>): Promise<void> {
  const id = msg.id;
  if (!source) throw new Error('No source audio loaded in the render worker');
  inFlight = 0;
  let lastProgress = 0;
  const yielder = makeYielder();
  const result = await exportWavPieces(
    {
      buffer: source,
      plan: msg.plan,
      crossfadeMs: msg.crossfadeMs,
      bitDepth: msg.bitDepth,
      stretch: msg.stretch,
      chunkSeconds: msg.chunkSeconds,
      ...(msg.loopFile ? { loopFile: msg.loopFile } : {}),
    },
    {
      onHeader: (bytes) => scope.postMessage({ type: 'header', id, bytes: bytes.buffer }, [bytes.buffer]),
      onChunk: (bytes) => {
        inFlight += bytes.byteLength;
        scope.postMessage({ type: 'data', id, bytes }, [bytes]);
      },
      onProgress: (fraction, done, total) => {
        const now = performance.now();
        if (now - lastProgress < 100 && fraction < 1) return;
        lastProgress = now;
        scope.postMessage({ type: 'progress', id, fraction, done, total });
      },
      yieldNow: yielder,
    },
  );
  scope.postMessage({ type: 'exported', id, frames: result.frames, bytes: result.bytes });
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'setSource') {
      source = makeBuffer(msg.channels, msg.sampleRate);
      cached = null;
    } else if (msg.type === 'ack') {
      inFlight = Math.max(0, inFlight - msg.bytes);
      if (ackWaiter && inFlight <= MAX_IN_FLIGHT_BYTES) {
        const wake = ackWaiter;
        ackWaiter = null;
        wake();
      }
    } else if (msg.type === 'chunk') {
      const renderer = rendererFor(msg.plan, msg.crossfadeMs);
      const channels = renderer.render(msg.start, msg.frames);
      scope.postMessage({ type: 'chunk', id: msg.id, channels, total: renderer.total }, channels.map((c) => c.buffer));
    } else if (msg.type === 'export') {
      runExport(msg).catch((err: unknown) => {
        if (err instanceof ExportCancelled) return;
        scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (err) {
    const id = 'id' in msg ? msg.id : -1;
    scope.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
