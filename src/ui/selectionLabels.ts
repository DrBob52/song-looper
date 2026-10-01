// Where the timestamps at a selection's edges go on the waveform (SPEC-v1.3.md 7.2). Pure arithmetic, so it is unit-tested.

/** Pixels between a selection edge and its timestamp, and the least gap between two timestamps. */
const LABEL_GAP = 3;
const LABEL_MIN_SPACE = 6;

/**
 * Where the timestamps of a selection go on a waveform `width` px wide (SPEC-v1.3.md 7.2). Each edge's label sits just
 * outside its edge (the start label to the left of the start, the end label to the right of the end) and flips to the
 * inside when it would run off the waveform. A selection narrower than the combined label `start–end` gets that one label,
 * centred on it, and so does any selection whose two labels would touch. Returns the left offsets in px.
 */
export function placeSelectionLabels(
  x0: number,
  x1: number,
  width: number,
  w: { start: number; end: number; both: number },
): { kind: 'edges'; start: number; end: number } | { kind: 'both'; left: number } {
  const combined = (): { kind: 'both'; left: number } => ({
    kind: 'both',
    left: Math.max(0, Math.min(width - w.both, (x0 + x1) / 2 - w.both / 2)),
  });
  if (x1 - x0 < w.both) return combined();
  let start = x0 - LABEL_GAP - w.start;
  if (start < 0) start = x0 + LABEL_GAP;
  let end = x1 + LABEL_GAP;
  if (end + w.end > width) end = x1 - LABEL_GAP - w.end;
  // each label stays on the waveform; and the two never touch
  if (start < 0 || end < 0 || start + w.start > width || end + w.end > width) return combined();
  const [a, b] = start <= end ? [{ at: start, w: w.start }, { at: end, w: w.end }] : [{ at: end, w: w.end }, { at: start, w: w.start }];
  if (a.at + a.w + LABEL_MIN_SPACE > b.at) return combined();
  return { kind: 'edges', start, end };
}
