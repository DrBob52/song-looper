import type { SeamChip, SeamReport, SeamScores } from '../analysis/types';
import type { SeamPlan } from '../model';

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

/** Tooltip of the Seam chip: the scores after smoothing, and before it when the smoother changed the seam. */
export function chipTitle(report: SeamReport): string {
  const after = `Seam ${scoresText(report.scores)}`;
  const changed = report.plan && Math.abs(report.before.quality - report.scores.quality) >= 0.005;
  const compare = changed ? ` Before smoothing: ${scoresText(report.before)}.` : '';
  return `${after}.${compare} ${harmonyText(report.harmony)}`;
}

const signedMs = (seconds: number): string => {
  const ms = Math.round(seconds * 1000);
  return `${ms > 0 ? '+' : ms < 0 ? '\u2212' : ''}${Math.abs(ms)} ms`;
};

/** The one-line summary of what the smoother did, e.g. "Seam moved +61 ms · aligned +7 ms · fade 40 ms". */
export function seamSummary(plan: SeamPlan): string {
  const parts: string[] = [Math.abs(plan.shift) < 0.0005 ? 'Seam kept' : `Seam moved ${signedMs(plan.shift)}`];
  if (Math.abs(plan.align) >= 0.0005) parts.push(`aligned ${signedMs(plan.align)}`);
  const jump = plan.jumps[plan.jumps.length - 1];
  if (jump?.fadeMs !== undefined) parts.push(`fade ${Math.round(jump.fadeMs)} ms`);
  if (jump?.levelDb) parts.push(`level ${jump.levelDb > 0 ? '+' : '\u2212'}${Math.abs(jump.levelDb).toFixed(1)} dB`);
  return parts.join(' \u00b7 ');
}
