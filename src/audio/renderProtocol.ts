import type { Plan } from '../model';
import type { BitDepth } from './wav';

export interface StretchParams {
  /** Playback speed factor, 1 = unchanged (tempo only, pitch preserved). */
  tempo: number;
  /** Pitch shift in semitones, 0 = unchanged (tempo preserved). */
  pitchSemitones: number;
}

export type WorkerRequest =
  | { type: 'setSource'; channels: Float32Array[]; sampleRate: number }
  | { type: 'render'; id: number; plan: Plan; crossfadeMs: number }
  | {
      type: 'export';
      id: number;
      plan: Plan;
      crossfadeMs: number;
      bitDepth: BitDepth;
      stretch: StretchParams | null;
    };

export type ExportStage = 'render' | 'stretch' | 'encode';

export type WorkerResponse =
  | { type: 'rendered'; id: number; channels: Float32Array[]; sampleRate: number }
  | { type: 'progress'; id: number; stage: ExportStage; pct: number }
  | { type: 'exported'; id: number; blob: Blob }
  | { type: 'error'; id: number; message: string };
