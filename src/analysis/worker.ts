/// Analysis worker: runs the pure DSP pipeline and keeps the session cached for cheap re-runs.
import { AnalysisSession } from './pipeline';
import type { AnalysisRequest, AnalysisResponse } from './protocol';
import type { AnalysisStage } from './types';

interface WorkerScope {
  postMessage(message: AnalysisResponse): void;
  onmessage: ((ev: MessageEvent<AnalysisRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let session: AnalysisSession | null = null;

scope.onmessage = (ev) => {
  const msg = ev.data;
  try {
    const report = (stage: AnalysisStage, pct: number): void =>
      scope.postMessage({ type: 'progress', id: msg.id, stage, pct });
    if (msg.type === 'analyze') {
      session = new AnalysisSession(msg.samples, msg.sampleRate);
      const analysis = session.run(msg.beatsPerBar, report);
      scope.postMessage({ type: 'result', id: msg.id, analysis });
    } else if (msg.type === 'update') {
      if (!session) throw new Error('No analysis session');
      const analysis = session.update(msg.change, report);
      scope.postMessage({ type: 'result', id: msg.id, analysis });
    } else if (msg.type === 'seamReport') {
      if (!session) throw new Error('No analysis session');
      scope.postMessage({ type: 'seamReport', id: msg.id, reports: session.seamReport(msg.regions) });
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
