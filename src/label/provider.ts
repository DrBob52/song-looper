import type { Analysis, LoopCandidate } from '../analysis/types';

/**
 * Hook for an optional labeller (for example an LLM-backed one) that names loop candidates, such as
 * "Chorus hook" or "Verse groove". It returns one label per candidate, in order; an empty string means
 * "no label". Nothing in v1 calls a network service: the default provider returns no labels.
 */
export interface LabelProvider {
  label(analysis: Analysis, candidates: LoopCandidate[]): Promise<string[]>;
}

/** The default provider: no labels. */
export const noopLabelProvider: LabelProvider = {
  label: (_analysis, candidates) => Promise.resolve(candidates.map(() => '')),
};
