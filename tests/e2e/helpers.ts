import type { Page } from '@playwright/test';
import { encodeWavBytes } from '../../src/audio/wav';
import type { SynthSongOptions } from '../fixtures/synth';
import { synthSong } from '../fixtures/synth';

export interface Fixture {
  name: string;
  mimeType: string;
  buffer: Buffer;
  duration: number;
  sampleRate: number;
}

/** Build a WAV fixture from the synthetic song generator. Stereo copy with a slight level difference. */
export async function makeFixture(
  options: SynthSongOptions = {},
  name = 'fixture-song.wav',
): Promise<Fixture> {
  const song = synthSong({ sampleRate: 44100, ...options });
  const right = Float32Array.from(song.samples, (v) => v * 0.9);
  const bytes = await encodeWavBytes([song.samples, right], song.sampleRate, { bitDepth: 16, dither: false });
  return {
    name,
    mimeType: 'audio/wav',
    buffer: Buffer.from(bytes),
    duration: song.duration,
    sampleRate: song.sampleRate,
  };
}

export async function loadFixture(page: Page, fixture: Fixture): Promise<void> {
  await page.goto('/');
  await page.setInputFiles('[data-testid=file-input]', {
    name: fixture.name,
    mimeType: fixture.mimeType,
    buffer: fixture.buffer,
  });
  await page.waitForSelector('[data-testid=song-panel]:not([hidden])');
}

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  duration: number;
  riffSizeOk: boolean;
}

/** Parse the canonical 44-byte header of a WAV file. */
export function parseWav(bytes: Buffer): WavInfo {
  const str = (o: number, n: number): string => bytes.subarray(o, o + n).toString('latin1');
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE' || str(12, 4) !== 'fmt ' || str(36, 4) !== 'data') {
    throw new Error('not a canonical WAV file');
  }
  const format = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  const dataBytes = bytes.readUInt32LE(40);
  return {
    format,
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    duration: dataBytes / (channels * (bitsPerSample / 8)) / sampleRate,
    riffSizeOk: bytes.readUInt32LE(4) === bytes.length - 8 && dataBytes === bytes.length - 44,
  };
}

/** Decode WAV bytes with the browser's decodeAudioData; returns duration, channels and peak. */
export async function decodeInBrowser(
  page: Page,
  bytes: Buffer,
): Promise<{ duration: number; channels: number; sampleRate: number; peak: number }> {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(arr.buffer);
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]!));
    }
    return { duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, peak };
  }, bytes.toString('base64'));
}

/** Drag across the waveform from `fromFrac` to `toFrac` of its width to make a selection. */
export async function dragSelect(page: Page, fromFrac: number, toFrac: number): Promise<void> {
  const box = await page.getByTestId('waveform').boundingBox();
  if (!box) throw new Error('waveform not visible');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * fromFrac;
  const x1 = box.x + box.width * toFrac;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y);
  await page.mouse.up();
}

/** Read a value out of the app store in the page. */
export async function appState<T>(page: Page, pick: string): Promise<T> {
  return page.evaluate(
    (expr) => {
      const app = (window as unknown as { songLooper: { store: { get(): unknown } } }).songLooper;
      return new Function('s', `return ${expr}`)(app.store.get());
    },
    pick,
  ) as Promise<T>;
}

/** Wait until the analysis worker has delivered its result. */
export async function waitForAnalysis(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = (window as unknown as { songLooper: { store: { get(): { analysisState: string } } } }).songLooper;
      return app.store.get().analysisState === 'done';
    },
    undefined,
    { timeout: 60_000 },
  );
}
