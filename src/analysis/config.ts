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

  /** 4.9 Loop candidates */
  candidates: {
    minBars: 2,
    maxBars: 32,
    minSeconds: 4,
    maxSongFraction: 0.5,
    /** Seam score window: compare S[a + j][b + j] for j in [-seamBeats, +seamBeats). */
    seamBeats: 4,
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
