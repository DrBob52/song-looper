import { SoundTouch } from '@soundtouchjs/core';
import type { StretchParams } from './renderProtocol';

const CHUNK = 8192;

export const MIN_TEMPO = 0.25;
export const MAX_TEMPO = 4;

/** True when neither speed nor pitch differs from the original. */
export function isNeutral(p: StretchParams | null | undefined): boolean {
  return !p || (Math.abs(p.tempo - 1) < 1e-6 && Math.abs(p.pitchSemitones) < 1e-6);
}

/** Length of the output for a given input length: the song plays `tempo` times faster. */
export function stretchedLength(frames: number, tempo: number): number {
  return Math.max(1, Math.round(frames / tempo));
}

/**
 * Offline SoundTouch for one stereo pair. SoundTouch v2 exposes pitch only: it time-stretches by 1 / pitch and
 * then transposes the rate by pitch. To add a tempo on top, the stretch stage is given tempo / pitch, so the rate
 * transposer supplies the pitch change (factor P) and the overall speed is (tempo / P) * P = tempo.
 */
function stretchPair(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  tempo: number,
  pitchFactor: number,
  onProgress: (fraction: number) => void,
): [Float32Array, Float32Array] {
  const n = left.length;
  const outLen = stretchedLength(n, tempo);
  const outL = new Float32Array(outLen);
  const outR = new Float32Array(outLen);
  const st = new SoundTouch({ sampleRate });
  st.pitch = pitchFactor;
  st.stretch.tempo = tempo / pitchFactor;

  const inBuf = new Float32Array(CHUNK * 2);
  const tmp = new Float32Array(CHUNK * 2);
  let written = 0;

  const drain = (): void => {
    for (;;) {
      const avail = st.outputBuffer.frameCount;
      if (avail <= 0 || written >= outLen) break;
      const take = Math.min(avail, CHUNK, outLen - written);
      st.outputBuffer.extract(tmp, 0, take);
      st.outputBuffer.receive(take);
      for (let i = 0; i < take; i++) {
        outL[written + i] = tmp[2 * i]!;
        outR[written + i] = tmp[2 * i + 1]!;
      }
      written += take;
    }
  };

  const feed = (from: number, frames: number, silence: boolean): void => {
    for (let i = 0; i < frames; i++) {
      inBuf[2 * i] = silence ? 0 : left[from + i]!;
      inBuf[2 * i + 1] = silence ? 0 : right[from + i]!;
    }
    st.inputBuffer.putSamples(inBuf, 0, frames);
    st.process();
    drain();
  };

  for (let pos = 0; pos < n; pos += CHUNK) {
    feed(pos, Math.min(CHUNK, n - pos), false);
    onProgress(pos / n);
  }
  // Flush the tail with silence until the expected length is produced.
  for (let guard = 0; written < outLen && guard < 64; guard++) feed(0, CHUNK, true);
  onProgress(1);
  return [outL, outR];
}

/**
 * Change speed (tempo only, pitch preserved) and pitch (semitones, tempo preserved) of rendered channels with
 * SoundTouch. The output is `tempo` times shorter than the input. Channels are processed as stereo pairs (a mono
 * file is processed as dual mono); files with more than two channels are processed pair by pair.
 */
export function stretchChannels(
  channels: Float32Array[],
  sampleRate: number,
  params: StretchParams,
  onProgress: (fraction: number) => void = () => undefined,
): Float32Array[] {
  const tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, params.tempo));
  const pitchFactor = Math.pow(2, params.pitchSemitones / 12);
  const pairs = Math.ceil(channels.length / 2);
  const out: Float32Array[] = [];
  for (let p = 0; p < pairs; p++) {
    const left = channels[2 * p]!;
    const right = channels[2 * p + 1] ?? left;
    const [l, r] = stretchPair(left, right, sampleRate, tempo, pitchFactor, (f) => onProgress((p + f) / pairs));
    out.push(l);
    if (2 * p + 1 < channels.length) out.push(r);
  }
  return out;
}
