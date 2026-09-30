/** A time span in seconds. */
export interface Span {
  start: number;
  end: number;
}

/** A user loop region, in seconds on the original song. */
export interface LoopRegion {
  id: string;
  start: number;
  end: number;
  /** 1 means play once (same as the original); up to MAX_REPEATS. */
  repeats: number;
  color: string;
  /** Suggestion score in [0, 1] when the region came from a suggestion. Used to split a target length. */
  score?: number;
  /** Snap edges to bar lines (true, the default) or beats (false) while dragging. */
  snapToBars?: boolean;
}

export interface Plan {
  regions: LoopRegion[];
}

export const MAX_REPEATS = 64;
export const MAX_EXTENDED_SECONDS = 60 * 60;

export const REGION_COLORS = [
  '#2563eb',
  '#db2777',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#65a30d',
];
