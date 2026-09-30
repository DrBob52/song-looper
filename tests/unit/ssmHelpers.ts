import type { SelfSimilarity } from '../../src/analysis/ssm';

/**
 * A block self-similarity matrix: beats in the same block (same letter) are similar (`inside`),
 * others are not (`outside`).
 */
export function makeSsm(blocks: string, beatsPerBlock: number, inside = 0.95, outside = 0.15): SelfSimilarity {
  const labels: string[] = [];
  for (const ch of blocks) for (let i = 0; i < beatsPerBlock; i++) labels.push(ch);
  const n = labels.length;
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i * n + j] = labels[i] === labels[j] ? inside : outside;
  return { S, n };
}
