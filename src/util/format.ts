/** "44.1 kHz", "48 kHz", "22.05 kHz". */
export function formatRate(sampleRate: number): string {
  return `${Number((sampleRate / 1000).toFixed(2))} kHz`;
}

/** "mono", "stereo" or "N ch". */
export function formatChannels(channels: number): string {
  return channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} ch`;
}
