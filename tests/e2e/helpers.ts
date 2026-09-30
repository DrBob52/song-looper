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
