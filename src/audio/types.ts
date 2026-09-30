/**
 * The subset of `AudioBuffer` that the DSP and render code needs. A real
 * `AudioBuffer` satisfies this structurally, and unit tests can build one from
 * plain typed arrays (Node has no AudioBuffer).
 */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

/** Build an AudioBufferLike from raw channel arrays. */
export function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  if (channels.length === 0) throw new Error('makeBuffer: need at least one channel');
  const length = channels[0]!.length;
  for (const c of channels) {
    if (c.length !== length) throw new Error('makeBuffer: channel length mismatch');
  }
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    duration: length / sampleRate,
    getChannelData: (ch: number) => {
      const c = channels[ch];
      if (!c) throw new RangeError(`channel ${ch} out of range`);
      return c;
    },
  };
}

/** Copy the channels out of an AudioBufferLike as plain arrays (no copy of data). */
export function channelsOf(buffer: AudioBufferLike): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}
