import type { AudioBufferLike } from './types';
import { channelsOf } from './types';

export interface LoopRange {
  start: number;
  end: number;
}

export type PlayerEvent = 'play' | 'pause' | 'ended' | 'seek' | 'load';

/**
 * Plays one AudioBuffer at a time (the original song or the rendered extended
 * version) with seek, optional loop range, and one-shot snippet playback for
 * seam auditioning.
 */
export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private snippet: AudioBufferSourceNode | null = null;
  private snippetDone: (() => void) | null = null;
  private playing = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private pausedAt = 0;
  private loop: LoopRange | null = null;
  private listeners = new Set<(ev: PlayerEvent) => void>();

  subscribe(fn: (ev: PlayerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: PlayerEvent): void {
    for (const fn of [...this.listeners]) fn(ev);
  }

  /** The shared AudioContext, created lazily (browsers require a user gesture to start it). */
  getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Use a decoded AudioBuffer as the playback source. Keeps the current position if asked. */
  setBuffer(buffer: AudioBuffer, keepPosition = false): void {
    const wasPlaying = this.playing;
    const pos = keepPosition ? Math.min(this.getTime(), buffer.duration) : 0;
    this.stopSource();
    this.buffer = buffer;
    this.pausedAt = pos;
    this.playing = false;
    this.emit('load');
    if (wasPlaying && keepPosition) void this.play(pos);
  }

  /** Build an AudioBuffer from raw channels (e.g. the rendered extended song) and use it. */
  setChannels(channels: Float32Array[], sampleRate: number, keepPosition = false): void {
    const ctx = this.getContext();
    const length = channels[0]?.length ?? 0;
    const buf = ctx.createBuffer(channels.length, Math.max(1, length), sampleRate);
    channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    this.setBuffer(buf, keepPosition);
  }

  getTime(): number {
    if (!this.buffer) return 0;
    if (!this.playing || !this.ctx) return this.pausedAt;
    let pos = this.startOffset + (this.ctx.currentTime - this.startCtxTime);
    const loop = this.loop;
    if (loop && pos >= loop.end) {
      const len = loop.end - loop.start;
      pos = loop.start + ((pos - loop.start) % len);
    }
    return Math.min(pos, this.buffer.duration);
  }

  async play(from?: number, loop?: LoopRange | null): Promise<void> {
    if (!this.buffer) return;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopSnippet();
    this.stopSource();
    if (loop !== undefined) this.loop = loop;
    let offset = from ?? this.pausedAt;
    if (offset >= this.buffer.duration - 0.01) offset = 0;
    if (this.loop && (offset < this.loop.start || offset >= this.loop.end)) offset = this.loop.start;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    if (this.loop) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }
    src.connect(this.master!);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = false;
      this.pausedAt = this.buffer ? this.buffer.duration : 0;
      this.emit('ended');
    };
    this.startCtxTime = ctx.currentTime;
    this.startOffset = offset;
    src.start(0, offset);
    this.source = src;
    this.playing = true;
    this.emit('play');
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.getTime();
    this.playing = false;
    this.stopSource();
    this.emit('pause');
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Stop playback and clear any loop range. */
  stop(): void {
    const wasPlaying = this.playing;
    this.stopSource();
    this.stopSnippet();
    this.loop = null;
    this.playing = false;
    this.pausedAt = 0;
    if (wasPlaying) this.emit('pause');
  }

  seek(t: number): void {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(this.buffer.duration, t));
    if (this.playing) void this.play(clamped);
    else this.pausedAt = clamped;
    this.emit('seek');
  }

  getLoop(): LoopRange | null {
    return this.loop;
  }

  /** Change or clear the loop range. While playing, playback continues inside the new range. */
  setLoop(loop: LoopRange | null): void {
    this.loop = loop;
    if (this.playing) {
      const t = this.getTime();
      void this.play(loop && (t < loop.start || t >= loop.end) ? loop.start : t);
    }
  }

  /** Play a short standalone buffer (seam audition). Resolves when it ends or is stopped. */
  async playSnippet(buffer: AudioBufferLike): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.pause();
    this.stopSnippet();
    const chans = channelsOf(buffer);
    const buf = ctx.createBuffer(chans.length, Math.max(1, buffer.length), buffer.sampleRate);
    chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master!);
    this.snippet = src;
    await new Promise<void>((resolve) => {
      this.snippetDone = resolve;
      src.onended = () => {
        if (this.snippet === src) this.snippet = null;
        this.snippetDone = null;
        resolve();
      };
      src.start();
    });
  }

  stopSnippet(): void {
    if (!this.snippet) return;
    const s = this.snippet;
    const done = this.snippetDone;
    this.snippet = null;
    this.snippetDone = null;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
    done?.();
  }

  isSnippetPlaying(): boolean {
    return this.snippet !== null;
  }

  private stopSource(): void {
    const s = this.source;
    if (!s) return;
    this.source = null;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
    s.disconnect();
  }
}
