/// Render/export worker: splices the plan, optionally time-stretches/pitch-shifts, and encodes WAV.
import { renderExtended } from './render';
import type { WorkerRequest, WorkerResponse } from './renderProtocol';
import type { AudioBufferLike } from './types';
import { makeBuffer } from './types';
import { isNeutral, stretchChannels } from './stretch';
import { encodeWav } from './wav';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let source: AudioBufferLike | null = null;

scope.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'setSource') {
      source = makeBuffer(msg.channels, msg.sampleRate);
    } else if (msg.type === 'render') {
      if (!source) throw new Error('No source audio loaded in the render worker');
      const channels = renderExtended(source, msg.plan, { crossfadeMs: msg.crossfadeMs });
      scope.postMessage(
        { type: 'rendered', id: msg.id, channels, sampleRate: source.sampleRate },
        channels.map((c) => c.buffer),
      );
    } else if (msg.type === 'export') {
      if (!source) throw new Error('No source audio loaded in the render worker');
      const id = msg.id;
      const progress = (stage: 'render' | 'stretch' | 'encode', pct: number): void =>
        scope.postMessage({ type: 'progress', id, stage, pct });
      let channels = renderExtended(source, msg.plan, {
        crossfadeMs: msg.crossfadeMs,
        onProgress: (f) => progress('render', f),
      });
      const sampleRate = source.sampleRate;
      if (msg.stretch && !isNeutral(msg.stretch)) {
        progress('stretch', 0);
        channels = stretchChannels(channels, sampleRate, msg.stretch, (f) => progress('stretch', f));
      }
      const blob = encodeWav(channels, sampleRate, {
        bitDepth: msg.bitDepth,
        onProgress: (f) => progress('encode', f),
      });
      channels = [];
      scope.postMessage({ type: 'exported', id, blob });
    }
  } catch (err) {
    const id = 'id' in msg ? msg.id : -1;
    scope.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
