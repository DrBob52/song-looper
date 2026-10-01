/**
 * Every tunable weight and threshold of the analysis pipeline lives here, so they are easy
 * to find and tune. See SPEC.md section 4 for what each stage does.
 */
export const ANALYSIS_CONFIG = {
  /** The worker analyses mono audio at this rate. */
  sampleRate: 22050,

  /** 4.1 STFT */
  stft: { frameSize: 2048, hop: 512 },

  /** 4.2 Onset strength */
  onset: {
    /** log(1 + logGain * magnitude) compression. Magnitudes are amplitude-normalised (a full-scale sine is 1). */
    logGain: 100,
    /** Moving-average window subtracted from the flux. */
    localMeanSeconds: 0.5,
  },

  /** 4.3 Tempo */
  tempo: {
    minBpm: 60,
    maxBpm: 200,
    /** Log-normal prior centre (BPM) and width (octaves) that discourages half/double-tempo picks. */
    priorBpm: 120,
    priorSigmaOctaves: 1.0,
    /** BPM resolution of the autocorrelation search. */
    gridStepBpm: 0.25,
    /** The alternative tempo must differ from the best by at least this fraction. */
    altMinSeparation: 0.12,
    /** Below this autocorrelation confidence the beat is "not steady". */
    minConfidence: 0.1,
  },

  /** 4.4 Beat tracking (Ellis dynamic programming) */
  beats: {
    /** librosa's "tightness": weight of the tempo-deviation penalty. */
    tightness: 100,
    /** Trim weak beats at the start and end. */
    trim: true,
    /**
     * The coarse tracker works on 23 ms frames whose onset peak precedes the true attack, so each beat
     * is refined on a fine-resolution onset curve inside this window (seconds before / after).
     */
    refineBefore: 0.06,
    refineAfter: 0.09,
    /**
     * The flux of the very first frame is undefined, so a beat at t = 0 can never be detected. If the first
     * tracked beat is about k periods after 0 (k <= prependMaxBeats, within prependToleranceSeconds), the
     * missing k beats are filled in so that loops can start at the beginning of the song.
     */
    prependMaxBeats: 4,
    prependToleranceSeconds: 0.05,
    /**
     * Broadband flux can lock onto off-beat hi-hats. If low-frequency (kick) onsets are this many times
     * stronger half a beat away from the tracked beats, move the beats there.
     */
    lfPhaseRatio: 1.3,
    /** Fine onset curve resolution. */
    fineFrameSize: 512,
    fineHop: 128,
    /**
     * Constant latency (seconds) of the fine onset curve's peak relative to the true attack; the
     * refined beat time is the peak time minus this. Negative because the peak lands ~4 ms before
     * the click (calibrated on the synthetic click tracks in tests/unit/tempo-beats.test.ts).
     */
    fineLatency: -0.004,
  },

  /** 4.5 Bars */
  bars: {
    beatsPerBar: 4,
    /** Low-frequency band (Hz) whose energy marks downbeats. */
    lowFreqMaxHz: 150,
    /** Weight of onset strength and of low-frequency energy in the downbeat score. */
    onsetWeight: 1.0,
    lowFreqWeight: 1.0,
  },

  /** 4.6 Beat-synchronous features */
  features: {
    chromaMinHz: 55,
    chromaMaxHz: 5000,
    melBands: 40,
    mfccCount: 13,
    melMinHz: 30,
    /** Weights of the combined feature vector [chroma * wChroma, timbre * wTimbre]. */
    wChroma: 1.0,
    wTimbre: 0.6,
  },

  /** 4.7 Self-similarity */
  ssm: {
    /** Time-delay embedding: stack each beat with the next `delay` beats. */
    delay: 4,
  },

  /** 4.8 Sections */
  sections: {
    /**
     * Checkerboard kernel sizes in beats (full width). Each scale gives a novelty curve; the curves are
     * max-normalised and combined with a geometric mean, so only boundaries that show at every scale
     * survive (a small kernel alone reacts to every chord change, a large one alone localises poorly).
     */
    kernelScales: [16, 32],
    /** Minimum gap between novelty peaks, in beats. */
    minGapBeats: 8,
    /**
     * A peak must stand out from its surroundings: its prominence (height above the higher of the two
     * valleys next to it) must be at least this fraction of the most prominent peak's.
     */
    peakProminence: 0.3,
    /** Agglomerative clustering: merge while cosine distance between cluster means is below this. */
    clusterDistance: 0.25,
    /** Boundaries closer than this many bars to each other or to the song edges are dropped. */
    minSectionBars: 2,
  },

  /** SPEC-seams.md 2: harmonic transition model built from the song's own chord changes. */
  harmony: {
    /** `w`: beats on each side of a seam that must match somewhere in the song. */
    windowBeats: 2,
    /** The evidence is the mean of this many best matches that are at least one bar apart. */
    topMatches: 2,
    /**
     * A best match needs a second one, a bar or more away, to back it up (the mean of the top two). That is
     * waived as the best match approaches an exact repeat: at `exactMatch` and above (both windows at least this
     * similar) it stands alone, below `corroborateBelow` it is the plain mean of the top two, and in between the
     * second match's share fades linearly. Without this, a chord change that the song plays exactly once (the
     * seam from the end of B back into A in A B A B) scores as if it were half a coincidence.
     */
    exactMatch: 0.98,
    corroborateBelow: 0.9,
    /** Random beat pairs used to normalise the evidence per song (median and 95th percentile). */
    sampleCount: 2000,
    /** Seed of the sampler, so a song always gets the same numbers. */
    sampleSeed: 20240607,
    /** A song whose p95 - p50 is below this is harmonically static: every seam scores 1. */
    minSpread: 0.02,
    /** Harmony at or above this reads "chords lead back cleanly"; below `poor`, "chord change isn't in the song". */
    good: 0.7,
    poor: 0.35,
  },

  /** 4.9 Loop candidates */
  candidates: {
    minBars: 2,
    maxBars: 32,
    minSeconds: 4,
    maxSongFraction: 0.5,
    /** Seam score window: compare S[a + j][b + j] for j in [-seamBeats, +seamBeats). */
    seamBeats: 4,
    /** SPEC-seams.md 6: context match looks at this many beats before / after the seam. */
    contextBeats: 4,
    /** SPEC-seams.md 6: seam = contextWeight * contextMatch + harmonyWeight * harmony. */
    seamContextWeight: 0.5,
    seamHarmonyWeight: 0.5,
    weights: { seam: 0.5, structure: 0.25, energy: 0.15, length: 0.1 },
    /** Structure score: bonus for a region that is exactly whole segments. */
    wholeSegmentBonus: 0.2,
    /** Energy continuity: dB difference that maps to zero score. */
    energyDbRange: 6,
    /** Length preference by bar count. */
    lengthPreferred: [4, 8, 16],
    lengthPreferredScore: 1.0,
    lengthEvenScore: 0.7,
    lengthOddScore: 0.4,
    /** Drop candidates overlapping a better one by more than this fraction. */
    nmsOverlap: 0.6,
    /** How many to keep. */
    maxCandidates: 12,
    /** Stars: score thresholds for 1..5 stars (ascending). */
    starThresholds: [0.3, 0.45, 0.6, 0.75],
  },

  /** SPEC-seams.md 3: how a seam is scored (and later smoothed). */
  seam: {
    /** Seam quality: harmony is what the user hears, so it gets half the weight (SPEC-seams.md 3.5). */
    quality: { transient: 0.25, spectral: 0.25, harmony: 0.5 },
    /**
     * Chip thresholds on the seam quality: at least `clean` reads Clean, at least `ok` reads OK, else Rough.
     * `ok` sits above 0.5, the best a seam can do when the chord change is not in the song at all.
     */
    chip: { clean: 0.7, ok: 0.55 },
    /**
     * Transient cover: the seam hides best right before a strong hit. A hit whose onset peak lies within
     * `aheadMs` after the seam counts for it; a hit within `behindMs` around the seam (the seam slices through
     * an attack) counts against it by `behindWeight`. Strengths are relative to the `refPercentile` of the
     * song's beat-onset strengths.
     */
    transient: { aheadMs: [6, 40], behindMs: [20, 3], behindWeight: 0.5, refPercentile: 0.5, nearMs: [30, 40] },
    /**
     * Spectral continuity compares the last analysis frame wholly before the loop end with the first one wholly
     * after the loop start (`frameOffset` frames from the edges, so that neither overlaps the other side), and
     * normalises by the song's typical change across the same bar position (`bucketsPerBeat` positions per beat;
     * a position with fewer than `minSamples` frames pools its neighbours, up to `maxSpread` on either side).
     * `minTypicalDb` stops a flat part of the song from making every change look huge.
     */
    spectral: { frameOffset: 2, minTypicalDb: 0.5, bucketsPerBeat: 32, minSamples: 5, maxSpread: 3 },

    /**
     * 3.1 Rotation: both loop edges move together (the loop keeps its length), at most one beat either way. Every
     * `stepBeats` of a beat is scored, then the best `refineTop` are refined in `refineStepMs` steps within
     * `refineRangeMs`. `movePenalty` (per beat moved) and `minGain` keep a seam that is already good where it is.
     */
    rotation: {
      stepBeats: 0.25,
      weights: { transient: 0.4, spectral: 0.4, harmony: 0.2 },
      refineTop: 2,
      refineStepMs: 5,
      refineRangeMs: 30,
      movePenalty: 0.03,
      minGain: 0.02,
    },

    /**
     * 3.2 Micro-alignment: the end edge alone moves by at most `maxMs`, to the lag where the fine onset curves around
     * the two edges (STFT `frameSize` / `hop` at the analysis rate, `beforeSeconds` and `afterSeconds` of context)
     * correlate best. With no transient on either side (peak flux below `flatFlux`) the mid-channel waveform
     * (`waveformMs` of context each side) is used instead. A lag must beat not moving by `minGain`.
     */
    align: {
      maxMs: 20,
      frameSize: 256,
      hop: 16,
      beforeSeconds: 0.15,
      afterSeconds: 0.15,
      flatFlux: 4,
      waveformMs: 30,
      minGain: 0.02,
      movePenaltyPerMs: 0.0005,
    },

    /**
     * 3.3 Adaptive fade: the shortest of these lengths (and one beat) whose spectral discontinuity across the rendered
     * seam is within `tolerance` of the best (plus `floor`, in flux units). With harmony below `poorHarmony` only fades
     * up to `poorMaxMs` are allowed: a long fade smears two chords together.
     */
    fade: {
      candidatesMs: [10, 20, 40, 80, 160],
      poorHarmony: 0.5,
      poorMaxMs: 40,
      contextMs: 80,
      frameSize: 256,
      hop: 64,
      zonePadMs: 6,
      /** Flux compression log(1 + gamma * magnitude) for this measure: near-linear, so a slow fade scores lower than a quick one. */
      gamma: 1,
      tolerance: 0.15,
      floor: 0.05,
    },

    /** 3.4 Level match: when the last and first beats differ by more than `thresholdDb`, ramp the last beat (at most `maxDb`). */
    level: { thresholdDb: 1.5, maxDb: 9 },
  },

  /**
   * SPEC-seams.md 4: when a loop's harmony is under `under`, look for a loop whose start is within `startBars` bars of
   * its start and whose end is within `endBars` bars of its end, a whole number of bars long, with the best harmony
   * (the candidate score breaks ties between harmonies within `tie` of each other). It is only offered when its
   * harmony is at least `minHarmony` and `minGain` better.
   */
  nearby: { under: 0.5, startBars: 1, endBars: 2, minHarmony: 0.7, minGain: 0.2, tie: 0.01 },

  /** 10. Edge cases */
  limits: {
    /** Songs shorter than this (seconds) get no suggestions. */
    minSongSeconds: 20,
    /** Warn above this (seconds). */
    longSongSeconds: 20 * 60,
    /** Audio with peak amplitude below this is treated as silent. */
    silencePeak: 1e-4,
    /** Fewer beats than this means "no beats found". */
    minBeats: 8,
    /** Fallback snapping grid (seconds) when there is no steady beat. */
    fallbackGridSeconds: 0.5,
  },
} as const;

export type AnalysisConfig = typeof ANALYSIS_CONFIG;
