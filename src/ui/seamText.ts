import type { SeamChip, SeamReport, SeamScores } from '../analysis/types';

export function chipLabel(chip: SeamChip): string {
  return chip === 'clean' ? 'Clean' : chip === 'ok' ? 'OK' : 'Rough';
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** One line of the chip tooltip for a set of scores. */
export function scoresText(s: SeamScores): string {
  const harmony = s.harmony === null ? 'no beat grid' : `chord change ${pct(s.harmony)}`;
  return `quality ${pct(s.quality)} (hit cover ${pct(s.transient)}, spectrum ${pct(s.spectral)}, ${harmony})`;
}

/** What the harmony number means, in words. */
export function harmonyText(harmony: number | null): string {
  if (harmony === null) return 'There is no steady beat, so the chord change is not checked.';
  if (harmony >= 0.7) return 'The song makes this chord change itself.';
  if (harmony < 0.35) return 'The song never makes this chord change.';
  return 'The song comes close to this chord change.';
}

/** Tooltip of the Seam chip. */
export function chipTitle(report: SeamReport): string {
  return `Seam ${scoresText(report.scores)}. ${harmonyText(report.harmony)}`;
}
