import { ANALYSIS_CONFIG } from './config';
import type { BeatFeatures } from './features';
import type { SelfSimilarity } from './ssm';
import type { Section } from './types';

type SectionConfig = typeof ANALYSIS_CONFIG.sections;

/**
 * Novelty curve from sliding a Gaussian-tapered checkerboard kernel along the diagonal of S.
 * novelty[i] is high when the `kernel/2` beats before i are similar to each other, the `kernel/2`
 * beats from i on are similar to each other, and the two halves differ. Outside the matrix S reads as 0.
 */
export function noveltyCurve(
  ssm: SelfSimilarity,
  kernelBeats = 16,
): Float32Array {
  const { S, n } = ssm;
  const L = Math.max(2, Math.floor(kernelBeats / 2));
  const size = 2 * L;
  const sigma = L / 2;
  const kernel = new Float32Array(size * size);
  for (let u = 0; u < size; u++) {
    const uc = u - L + 0.5;
    const su = uc < 0 ? -1 : 1;
    const gu = Math.exp(-0.5 * (uc / sigma) ** 2);
    for (let v = 0; v < size; v++) {
      const vc = v - L + 0.5;
      const sv = vc < 0 ? -1 : 1;
      const gv = Math.exp(-0.5 * (vc / sigma) ** 2);
      kernel[u * size + v] = su * sv * gu * gv;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let u = 0; u < size; u++) {
      const r = i + u - L;
      if (r < 0 || r >= n) continue;
      for (let v = 0; v < size; v++) {
        const c = i + v - L;
        if (c < 0 || c >= n) continue;
        acc += kernel[u * size + v]! * S[r * n + c]!;
      }
    }
    out[i] = acc;
  }
  return out;
}

/** Prominence of each local maximum: height above the higher of the lowest points on either side before a taller peak. */
export function peakProminences(curve: Float32Array): { index: number; prominence: number }[] {
  const n = curve.length;
  const out: { index: number; prominence: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(curve[i]! > curve[i - 1]! && curve[i]! >= curve[i + 1]!)) continue;
    let left = curve[i]!;
    for (let j = i - 1; j >= 0 && curve[j]! <= curve[i]!; j--) left = Math.min(left, curve[j]!);
    let right = curve[i]!;
    for (let j = i + 1; j < n && curve[j]! <= curve[i]!; j++) right = Math.min(right, curve[j]!);
    out.push({ index: i, prominence: curve[i]! - Math.max(left, right) });
  }
  return out;
}

/** Prominent local maxima at least `minGap` apart (the most prominent wins). */
export function pickPeaks(
  curve: Float32Array,
  minGap: number,
  cfg: Pick<SectionConfig, 'peakProminence'> = ANALYSIS_CONFIG.sections,
): number[] {
  const peaks = peakProminences(curve);
  let maxProm = 0;
  for (const p of peaks) maxProm = Math.max(maxProm, p.prominence);
  if (maxProm <= 1e-9) return [];
  const strong = peaks.filter((p) => p.prominence >= cfg.peakProminence * maxProm);
  strong.sort((a, b) => b.prominence - a.prominence);
  const chosen: number[] = [];
  for (const p of strong) if (chosen.every((q) => Math.abs(q - p.index) >= minGap)) chosen.push(p.index);
  return chosen.sort((a, b) => a - b);
}

/** Geometric mean of the max-normalised novelty curves of several kernel sizes. */
export function multiScaleNovelty(
  ssm: SelfSimilarity,
  scales: readonly number[] = ANALYSIS_CONFIG.sections.kernelScales,
): Float32Array {
  const n = ssm.n;
  const out = new Float32Array(n).fill(1);
  for (const k of scales) {
    const c = noveltyCurve(ssm, k);
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, c[i]!);
    for (let i = 0; i < n; i++) out[i] = out[i]! * (max > 0 ? Math.max(0, c[i]!) / max : 0);
  }
  const root = 1 / scales.length;
  for (let i = 0; i < n; i++) out[i] = Math.pow(out[i]!, root);
  return out;
}

export function labelName(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < 26 ? letters[index]! : `${letters[index % 26]}${Math.floor(index / 26) + 1}`;
}

function cosineDistance(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na < 1e-12 || nb < 1e-12) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}

/**
 * Agglomerative clustering (average of member means, cosine distance) of segments by their mean feature
 * vector. Returns a cluster index per segment, numbered by first appearance.
 */
export function clusterSegments(
  means: Float64Array[],
  weights: number[],
  threshold: number = ANALYSIS_CONFIG.sections.clusterDistance,
): number[] {
  interface Cluster {
    sum: Float64Array;
    weight: number;
    members: number[];
  }
  let clusters: Cluster[] = means.map((m, i) => ({
    sum: Float64Array.from(m, (x) => x * weights[i]!),
    weight: weights[i]!,
    members: [i],
  }));
  const mean = (c: Cluster): Float64Array => Float64Array.from(c.sum, (x) => x / Math.max(1e-9, c.weight));
  for (;;) {
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      const mi = mean(clusters[i]!);
      for (let j = i + 1; j < clusters.length; j++) {
        const d = cosineDistance(mi, mean(clusters[j]!));
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || best >= threshold) break;
    const a = clusters[bi]!;
    const b = clusters[bj]!;
    const merged: Cluster = {
      sum: Float64Array.from(a.sum, (x, k) => x + b.sum[k]!),
      weight: a.weight + b.weight,
      members: [...a.members, ...b.members],
    };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }
  const assignment = new Array<number>(means.length).fill(-1);
  clusters.forEach((c, id) => c.members.forEach((m) => (assignment[m] = id)));
  // renumber by first appearance
  const order = new Map<number, number>();
  return assignment.map((id) => {
    if (!order.has(id)) order.set(id, order.size);
    return order.get(id)!;
  });
}

export interface SectionResult {
  sections: Section[];
  /** Beat indices at which a section starts (includes 0 and the first bar). */
  boundaries: number[];
  novelty: Float32Array;
}

/**
 * Sections from the self-similarity matrix: novelty peaks snapped to bar lines, then clustered and
 * labelled A, B, C... in order of first appearance.
 */
export function findSections(input: {
  ssm: SelfSimilarity;
  features: BeatFeatures;
  beats: number[];
  /** Beat indices that start a bar. */
  barBeats: number[];
  beatsPerBar: number;
  duration: number;
  delay: number;
  cfg?: SectionConfig;
}): SectionResult {
  const cfg = input.cfg ?? ANALYSIS_CONFIG.sections;
  const { ssm, features, beats, barBeats, beatsPerBar, duration, delay } = input;
  const n = beats.length;
  const novelty = multiScaleNovelty(ssm, cfg.kernelScales);
  const peaks = pickPeaks(novelty, cfg.minGapBeats, cfg);

  // Embedding at index i looks `delay` beats ahead, so block edges sit about delay/2 beats early.
  const shift = Math.round(delay / 2);
  const minBeats = cfg.minSectionBars * beatsPerBar;
  const firstBar = barBeats.length ? barBeats[0]! : 0;
  const candidates = peaks.map((p) => {
    const raw = p + shift;
    let best = barBeats.length ? barBeats[0]! : raw;
    for (const b of barBeats) if (Math.abs(b - raw) < Math.abs(best - raw)) best = b;
    return { beat: best, strength: novelty[p]! };
  });
  // Strongest first, enforce a minimum distance between boundaries (and from the song edges).
  candidates.sort((a, b) => b.strength - a.strength);
  const accepted: number[] = [];
  for (const c of candidates) {
    if (c.beat - firstBar < minBeats || n - c.beat < minBeats) continue;
    if (accepted.every((q) => Math.abs(q - c.beat) >= minBeats)) accepted.push(c.beat);
  }
  accepted.sort((a, b) => a - b);

  const starts = [0, ...accepted];
  const ends = [...accepted, n];
  const dims = features.dims;
  const means: Float64Array[] = [];
  const weights: number[] = [];
  const loud: number[] = [];
  starts.forEach((s, k) => {
    const e = ends[k]!;
    const m = new Float64Array(dims);
    let l = 0;
    for (let i = s; i < e; i++) {
      for (let d = 0; d < dims; d++) m[d] = m[d]! + features.combined[i * dims + d]!;
      l += features.loudness[i]!;
    }
    const count = Math.max(1, e - s);
    for (let d = 0; d < dims; d++) m[d] = m[d]! / count;
    means.push(m);
    weights.push(count);
    loud.push(l / count);
  });
  const cluster = clusterSegments(means, weights, cfg.clusterDistance);

  // "Likely chorus" hint: the label that repeats most, ties broken by loudness. Only a hint.
  const stats = new Map<number, { count: number; loud: number }>();
  cluster.forEach((c, k) => {
    const s = stats.get(c) ?? { count: 0, loud: 0 };
    s.count += 1;
    s.loud += loud[k]!;
    stats.set(c, s);
  });
  let chorus = -1;
  if (stats.size >= 2) {
    let bestKey: [number, number] = [1, -Infinity];
    for (const [c, s] of stats) {
      const key: [number, number] = [s.count, s.loud / s.count];
      if (s.count >= 2 && (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1]))) {
        bestKey = key;
        chorus = c;
      }
    }
  }

  const sections: Section[] = starts.map((s, k) => ({
    start: k === 0 ? 0 : beats[s]!,
    end: k === starts.length - 1 ? duration : beats[ends[k]!]!,
    label: labelName(cluster[k]!),
    hint: cluster[k] === chorus ? 'likely chorus' : undefined,
    startBeat: s,
    endBeat: ends[k]!,
  }));
  const boundaries = [...new Set([0, firstBar, ...accepted])].sort((a, b) => a - b);
  return { sections, boundaries, novelty };
}
