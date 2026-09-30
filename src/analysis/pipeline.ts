import { barBeatIndices, downbeatEvidence, pickBarPhase } from './bars';
import { correctBeatPhase, refineBeatTimes, tempoFromBeats, trackBeatFrames } from './beats';
import type { FineOnset } from './beats';
import { ANALYSIS_CONFIG } from './config';
import { computeFineOnset, computeFrameData } from './features';
import type { FrameData } from './features';
import { estimateTempo } from './tempo';
import type { TempoResult } from './tempo';
import type { Analysis, AnalysisStage, AnalysisUpdate } from './types';

export type ProgressFn = (stage: AnalysisStage, pct: number) => void;

function peakOf(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Runs the analysis and caches the expensive parts (the per-frame STFT data and the fine onset curve)
 * so that changing the tempo, beats per bar or bar phase only re-runs the later stages.
 */
export class AnalysisSession {
  private frameData: FrameData | null = null;
  private fine: FineOnset | null = null;
  private tempo: TempoResult | null = null;
  private beatTimes: number[] = [];
  private bpmRefined: number = ANALYSIS_CONFIG.tempo.priorBpm;
  private beatsPerBar: number = ANALYSIS_CONFIG.bars.beatsPerBar;
  private autoPhase = 0;
  private phaseShift = 0;
  private bpmOverride: number | null = null;
  private silent = false;

  constructor(
    private samples: Float32Array,
    private sampleRate: number,
  ) {}

  get duration(): number {
    return this.samples.length / this.sampleRate;
  }

  /** Full analysis. */
  run(beatsPerBar: number, progress: ProgressFn = () => undefined): Analysis {
    this.beatsPerBar = beatsPerBar;
    this.phaseShift = 0;
    this.bpmOverride = null;
    this.silent = peakOf(this.samples) < ANALYSIS_CONFIG.limits.silencePeak;
    if (this.silent) return this.assemble();

    progress('stft', 0);
    this.frameData = computeFrameData(this.samples, this.sampleRate, (f) => progress('stft', f));
    progress('stft', 1);
    this.computeBeats(progress);
    this.computeBars();
    return this.assemble(progress);
  }

  /** Re-run from the changed stage onward using cached data. */
  update(change: AnalysisUpdate, progress: ProgressFn = () => undefined): Analysis {
    if (this.silent || !this.frameData) return this.assemble();
    let rebeat = false;
    if (change.bpm !== undefined) {
      this.bpmOverride = change.bpm;
      rebeat = true;
    }
    if (change.beatsPerBar !== undefined && change.beatsPerBar !== this.beatsPerBar) {
      this.beatsPerBar = change.beatsPerBar;
      this.phaseShift = 0;
    }
    if (rebeat) {
      this.phaseShift = 0;
      this.computeBeats(progress);
      this.computeBars();
    } else if (change.beatsPerBar !== undefined) {
      this.computeBars();
    }
    if (change.phaseShift) {
      const b = this.beatsPerBar;
      this.phaseShift = (((this.phaseShift + change.phaseShift) % b) + b) % b;
    }
    return this.assemble(progress);
  }

  // ---- stages ------------------------------------------------------------------

  private computeBeats(progress: ProgressFn): void {
    const fd = this.frameData!;
    progress('beats', 0);
    this.tempo = estimateTempo(fd.onset, fd.frameRate);
    progress('beats', 0.2);
    const target = this.bpmOverride ?? this.tempo.bpm;
    const frames = trackBeatFrames(fd.onset, fd.frameRate, target);
    const tracked = frames.map((f) => (f * fd.hop) / fd.sampleRate);
    const coarse = correctBeatPhase(tracked, fd.lfFlux, fd.frameRate).times;
    progress('beats', 0.4);
    this.fine ??= computeFineOnset(this.samples, this.sampleRate);
    progress('beats', 0.8);
    this.beatTimes = coarse.length ? refineBeatTimes(coarse, this.fine) : [];
    this.bpmRefined = tempoFromBeats(this.beatTimes) ?? target;
    progress('beats', 1);
  }

  private computeBars(): void {
    const fd = this.frameData!;
    if (this.beatTimes.length === 0) {
      this.autoPhase = 0;
      return;
    }
    const evidence = downbeatEvidence(this.beatTimes, fd.onset, fd.lowEnergy, fd.frameRate);
    this.autoPhase = pickBarPhase(evidence, this.beatsPerBar).phase;
  }

  /** Beat index of the first downbeat after the user's nudge. */
  private barPhase(): number {
    return (this.autoPhase + this.phaseShift) % this.beatsPerBar;
  }

  /** Bar starts as beat indices. */
  barBeats(): number[] {
    return barBeatIndices(this.beatTimes.length, this.barPhase(), this.beatsPerBar);
  }

  private assemble(_progress: ProgressFn = () => undefined): Analysis {
    const lim = ANALYSIS_CONFIG.limits;
    const confidence = this.tempo?.confidence ?? 0;
    const beats = this.beatTimes;
    const enoughBeats = beats.length >= lim.minBeats;
    const steady = !this.silent && enoughBeats && confidence >= ANALYSIS_CONFIG.tempo.minConfidence;
    const skipped: Analysis['skipped'] = this.silent
      ? 'silent'
      : this.duration < lim.minSongSeconds
        ? 'short'
        : !enoughBeats
          ? 'no-beats'
          : undefined;
    const autoBpm = this.tempo?.bpm ?? ANALYSIS_CONFIG.tempo.priorBpm;
    return {
      bpm: this.bpmRefined,
      bpmAlt: this.bpmOverride !== null ? autoBpm : (this.tempo?.bpmAlt ?? autoBpm * 2),
      beats,
      beatsPerBar: this.beatsPerBar,
      barPhase: this.silent || !enoughBeats ? 0 : this.barPhase(),
      sections: [],
      candidates: [],
      duration: this.duration,
      beatConfidence: confidence,
      steadyBeat: steady,
      silent: this.silent,
      skipped,
      bpmOverride: this.bpmOverride,
      autoBarPhase: this.autoPhase,
    };
  }
}

/** One-shot helper used by tests and the worker. */
export function analyzeSignal(
  samples: Float32Array,
  sampleRate: number,
  beatsPerBar: number = ANALYSIS_CONFIG.bars.beatsPerBar,
  progress?: ProgressFn,
): Analysis {
  return new AnalysisSession(samples, sampleRate).run(beatsPerBar, progress);
}
