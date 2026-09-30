/** Tunables for splicing and rendering. */
export const RENDER_CONFIG = {
  /** Default equal-power crossfade length at each loop seam, in milliseconds. */
  crossfadeMs: 20,
  /**
   * Blend from equal-power toward equal-gain as the two sides of a seam become correlated.
   * A pure equal-power fade of two identical signals swells by +3 dB in the middle; a
   * seam that matches well is exactly the case we want to be inaudible.
   */
  adaptiveCrossfade: true,
  crossfadeMinMs: 5,
  crossfadeMaxMs: 80,
  /** Loop edges snap to the nearest zero crossing within this many milliseconds. */
  zeroCrossRadiusMs: 2,
  /** Refuse to render an extended song longer than this. */
  maxExtendedSeconds: 60 * 60,
  /** Seam audition plays this many seconds before the seam and after it. */
  seamAuditionSeconds: 4,
  /** Warn before exporting a file larger than this many bytes. */
  largeFileBytes: 500 * 1024 * 1024,
  /** Rendering is debounced by this long after a plan change (ms). */
  renderDebounceMs: 300,
} as const;
