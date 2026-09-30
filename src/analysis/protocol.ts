import type { Analysis, AnalysisStage, AnalysisUpdate } from './types';

/** main -> worker. `id` lets the main thread ignore results of a superseded request. */
export type AnalysisRequest =
  | { type: 'analyze'; id: number; samples: Float32Array; sampleRate: number; beatsPerBar: number }
  | { type: 'update'; id: number; change: AnalysisUpdate };

/** worker -> main */
export type AnalysisResponse =
  | { type: 'progress'; id: number; stage: AnalysisStage; pct: number }
  | { type: 'result'; id: number; analysis: Analysis }
  | { type: 'error'; id: number; message: string };
