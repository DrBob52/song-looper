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
  /** Frames [start, start + frames) of the extended song, for the live preview. */
  | { type: 'chunk'; id: number; plan: Plan; crossfadeMs: number; start: number; frames: number }
  | {
      type: 'export';
      id: number;
      plan: Plan;
      crossfadeMs: number;
      bitDepth: BitDepth;
      stretch: StretchParams | null;
      /** Seconds rendered per piece (tests use small ones); default RENDER_CONFIG.exportChunkSeconds. */
      chunkSeconds?: number;
      /** Export one loop as a file of its own: `plan` has just that loop (SPEC-v1.3.md 7.1). */
      loopFile?: { loopReady: boolean };
    }
  /** The main thread has taken `bytes` of exported data (flow control: the worker never runs far ahead). */
  | { type: 'ack'; id: number; bytes: number };

export type WorkerResponse =
  | { type: 'chunk'; id: number; channels: Float32Array[]; total: number }
  /** The WAV header, then the pieces of the data, then `exported`. */
  | { type: 'header'; id: number; bytes: ArrayBuffer }
  | { type: 'data'; id: number; bytes: ArrayBuffer }
  | { type: 'progress'; id: number; fraction: number; done: number; total: number }
  | { type: 'exported'; id: number; frames: number; bytes: number }
  | { type: 'error'; id: number; message: string };
