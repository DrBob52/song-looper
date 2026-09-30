import { ANALYSIS_CONFIG } from './config';

export interface SelfSimilarity {
  /** N x N cosine similarity, row-major. */
  S: Float32Array;
  n: number;
}

/**
 * Stack each beat's features with the next `delay` beats (clamped at the end of the song), so that
 * the similarity compares short phrases instead of single beats.
 */
export function delayEmbed(features: Float32Array, n: number, dims: number, delay: number): { data: Float32Array; dims: number } {
  const outDims = dims * (delay + 1);
  const out = new Float32Array(n * outDims);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k <= delay; k++) {
      const src = Math.min(n - 1, i + k);
      out.set(features.subarray(src * dims, (src + 1) * dims), i * outDims + k * dims);
    }
  }
  return { data: out, dims: outDims };
}

/**
 * Beat-by-beat cosine similarity matrix of the time-delay-embedded features. Rows that are all zero
 * (silence) get zero similarity to everything except themselves.
 */
export function selfSimilarity(
  features: Float32Array,
  n: number,
  dims: number,
  delay: number = ANALYSIS_CONFIG.ssm.delay,
  onProgress?: (fraction: number) => void,
): SelfSimilarity {
  const { data, dims: d } = delayEmbed(features, n, dims, delay);
  // normalise rows
  for (let i = 0; i < n; i++) {
    let norm = 0;
    for (let k = 0; k < d; k++) norm += data[i * d + k]! * data[i * d + k]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let k = 0; k < d; k++) data[i * d + k] = data[i * d + k]! / norm;
  }
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const ri = i * d;
    for (let j = i; j < n; j++) {
      const rj = j * d;
      let dot = 0;
      for (let k = 0; k < d; k++) dot += data[ri + k]! * data[rj + k]!;
      S[i * n + j] = dot;
      S[j * n + i] = dot;
    }
    if (onProgress && i % 16 === 0) onProgress(i / n);
  }
  onProgress?.(1);
  return { S, n };
}
