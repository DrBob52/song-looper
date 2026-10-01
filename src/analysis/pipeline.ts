import { barBeatIndices, downbeatEvidence, pickBarPhase } from './bars';
import { correctBeatPhase, prependStartBeats, refineBeatTimes, tempoFromBeats, trackBeatFrames } from './beats';
import type { FineOnset } from './beats';
import { findCandidates } from './candidates';
import { ANALYSIS_CONFIG } from './config';
import { beatSyncFeatures, computeFineOnset, computeFrameData } from './features';
import type { BeatFeatures, FrameData } from './features';
import { buildHarmonyModel, chromaSimilarity } from './harmony';
import type { ChromaSimilarity, HarmonyModel } from './harmony';
import { findSections } from './sections';
import { selfSimilarity } from './ssm';
import type { SelfSimilarity } from './ssm';
import { estimateTempo } from './tempo';
import type { TempoResult } from './tempo';
import type { Analysis, AnalysisStage, AnalysisUpdate, LoopCandidate, Section } from './types';

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
  private features: BeatFeatures | null = null;
  private ssm: SelfSimilarity | null = null;
  private chromaSim: ChromaSimilarity | null = null;
  private harmonyModel: HarmonyModel | null = null;
  private sections: Section[] = [];
  private candidates: LoopCandidate[] = [];

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
    this.computeFeaturesAndSsm(progress);
    this.computeStructure(progress);
    return this.assemble();
  }

  /** Re-run from the changed stage onward using cached data. */
  update(change: AnalysisUpdate, progress: ProgressFn = () => undefined): Analysis {
    if (this.silent || !this.frameData) return this.assemble();
    let rebeat = false;
    let rebar = false;
    if (change.bpm !== undefined) {
      this.bpmOverride = change.bpm;
      rebeat = true;
    }
    if (change.beatsPerBar !== undefined && change.beatsPerBar !== this.beatsPerBar) {
      this.beatsPerBar = change.beatsPerBar;
      this.phaseShift = 0;
      rebar = true;
    }
    if (rebeat) {
      this.phaseShift = 0;
      this.computeBeats(progress);
      rebar = true;
    }
    if (rebar) this.computeBars();
    if (change.phaseShift) {
      const b = this.beatsPerBar;
      this.phaseShift = (((this.phaseShift + change.phaseShift) % b) + b) % b;
      rebar = true;
    }
    // Beat-synchronous features and the similarity matrix depend on the beats only; the sections
    // and candidates also depend on where the bar lines are.
    if (rebeat) this.computeFeaturesAndSsm(progress);
    if (rebar || rebeat) this.computeStructure(progress);
    return this.assemble();
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
    const refined = coarse.length ? refineBeatTimes(coarse, this.fine) : [];
    this.bpmRefined = tempoFromBeats(refined) ?? target;
    this.beatTimes = prependStartBeats(refined);
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

  /** Whether suggestions are computed at all for this song. */
  private canSuggest(): boolean {
    const lim = ANALYSIS_CONFIG.limits;
    return !this.silent && this.duration >= lim.minSongSeconds && this.beatTimes.length >= lim.minBeats;
  }

  private computeFeaturesAndSsm(progress: ProgressFn): void {
    this.features = null;
    this.ssm = null;
    this.chromaSim = null;
    this.harmonyModel = null;
    if (!this.canSuggest() || !this.frameData) return;
    progress('features', 0);
    this.features = beatSyncFeatures(this.frameData, this.beatTimes);
    this.chromaSim = chromaSimilarity(this.features.chroma, this.features.beats, this.features.chromaDims);
    progress('features', 1);
    progress('ssm', 0);
    this.ssm = selfSimilarity(this.features.combined, this.features.beats, this.features.dims, ANALYSIS_CONFIG.ssm.delay, (f) =>
      progress('ssm', f),
    );
    progress('ssm', 1);
  }

  private computeStructure(progress: ProgressFn): void {
    this.sections = [];
    this.candidates = [];
    if (!this.features || !this.ssm) return;
    progress('candidates', 0);
    const barBeats = this.barBeats();
    // The harmony model needs the bar length (matches must be a bar apart), so it follows the meter.
    this.harmonyModel = this.chromaSim ? buildHarmonyModel(this.chromaSim, this.beatsPerBar) : null;
    const { sections, boundaries } = findSections({
      ssm: this.ssm,
      features: this.features,
      beats: this.beatTimes,
      barBeats,
      beatsPerBar: this.beatsPerBar,
      duration: this.duration,
      delay: ANALYSIS_CONFIG.ssm.delay,
    });
    this.sections = sections;
    progress('candidates', 0.5);
    this.candidates = findCandidates({
      ssm: this.ssm,
      features: this.features,
      beats: this.beatTimes,
      barBeats,
      beatsPerBar: this.beatsPerBar,
      sections,
      boundaries,
      duration: this.duration,
      harmony: this.harmonyModel,
    });
    progress('candidates', 1);
  }

  /** Beat index of the first downbeat after the user's nudge. */
  private barPhase(): number {
    return (this.autoPhase + this.phaseShift) % this.beatsPerBar;
  }

  /** The harmonic transition model of the current beats (null when there are no features). */
  get harmony(): HarmonyModel | null {
    return this.harmonyModel;
  }

  /** The self-similarity matrix of the current beats (null when there are no features). */
  get similarity(): SelfSimilarity | null {
    return this.ssm;
  }

  /** Beat-synchronous features of the current beats (null when there are none). */
  get beatFeatures(): BeatFeatures | null {
    return this.features;
  }

  /** Bar starts as beat indices. */
  barBeats(): number[] {
    return barBeatIndices(this.beatTimes.length, this.barPhase(), this.beatsPerBar);
  }

  private assemble(): Analysis {
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
      sections: this.sections,
      candidates: this.candidates,
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
