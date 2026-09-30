import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';

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
  private speed = 1;
  private pitch = 0;
  /** Playback rate of the running source (speed at the time it started or was last re-anchored). */
  private rate = 1;
  private auxRate = 1;
  private stNode: SoundTouchNode | null = null;
  private auxStNode: SoundTouchNode | null = null;
  private workletReady: Promise<void> | null = null;
  private analyser: AnalyserNode | null = null;
  private aux: AudioBufferSourceNode | null = null;
  private auxDone: (() => void) | null = null;
  private auxStartCtx = 0;
  private auxOffset = 0;
  private auxDuration = 0;
  private auxLoop: LoopRange | null = null;
  private auxBuffer: AudioBuffer | null = null;
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

  /** An analyser tapped from the output, created on demand (used by tests and level checks). */
  getAnalyser(): AnalyserNode {
    const ctx = this.getContext();
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.master!.connect(this.analyser);
    }
    return this.analyser;
  }

  // ---- speed and pitch (SoundTouch AudioWorklet) ---------------------------------

  get speedValue(): number {
    return this.speed;
  }

  get pitchValue(): number {
    return this.pitch;
  }

  private get neutral(): boolean {
    return Math.abs(this.speed - 1) < 1e-6 && this.pitch === 0;
  }

  /** Load the SoundTouch processor into the AudioContext once. */
  private ensureWorklet(): Promise<void> {
    if (!this.workletReady) {
      this.workletReady = SoundTouchNode.register(this.getContext(), processorUrl).catch((err: unknown) => {
        this.workletReady = null;
        throw err;
      });
    }
    return this.workletReady;
  }

  /**
   * Route a source to the output, through SoundTouch when speed or pitch is not neutral. Tempo is driven by the
   * source's playbackRate (the worklet compensates the pitch), exactly as the library recommends.
   */
  private connectSource(src: AudioBufferSourceNode): SoundTouchNode | null {
    const ctx = this.getContext();
    if (this.neutral) {
      src.connect(this.master!);
      return null;
    }
    const st = new SoundTouchNode({ context: ctx });
    st.playbackRate.value = this.speed;
    st.pitchSemitones.value = this.pitch;
    src.playbackRate.value = this.speed;
    st.connect(this.master!);
    src.connect(st);
    return st;
  }

  /**
   * Change speed (0.5..1.5, tempo only) and pitch (semitones, tempo preserved). Takes effect immediately, also
   * while playing.
   */
  async setSpeedPitch(speed: number, pitch: number): Promise<void> {
    const wasNeutral = this.neutral;
    const ctx = this.ctx;
    // Re-anchor the position clock so the time stays continuous across the rate change.
    const mainPos = this.playing ? this.getTime() : 0;
    const auxPos = this.aux ? this.getAuxTime() : 0;
    this.speed = Math.min(1.5, Math.max(0.5, speed));
    this.pitch = Math.round(Math.min(12, Math.max(-12, pitch)));
    if (!this.neutral || !wasNeutral) {
      if (!this.neutral) await this.ensureWorklet();
    }
    if (this.playing && ctx) {
      if (wasNeutral !== this.neutral) {
        void this.play(mainPos);
      } else {
        this.startOffset = mainPos;
        this.startCtxTime = ctx.currentTime;
        this.rate = this.speed;
        if (this.source) this.source.playbackRate.value = this.speed;
        if (this.stNode) {
          this.stNode.playbackRate.value = this.speed;
          this.stNode.pitchSemitones.value = this.pitch;
        }
      }
    }
    if (this.aux && ctx) {
      // the audition/preview continues from the same position with the new settings
      if (wasNeutral !== this.neutral) this.restartAux(auxPos);
      else {
        this.auxOffset = auxPos;
        this.auxStartCtx = ctx.currentTime;
        this.auxRate = this.speed;
        this.aux.playbackRate.value = this.speed;
        if (this.auxStNode) {
          this.auxStNode.playbackRate.value = this.speed;
          this.auxStNode.pitchSemitones.value = this.pitch;
        }
      }
    }
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
    let pos = this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.rate;
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
    if (!this.neutral) await this.ensureWorklet();
    this.stopAux(false);
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
    this.stNode = this.connectSource(src);
    this.rate = this.speed;
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
    this.stopAux(false);
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

  /**
   * Play a standalone buffer (seam audition or loop preview) instead of the main buffer, at the current
   * speed and pitch. Resolves when it ends or is stopped. With `loopStart`/`loopEnd` it repeats until stopped.
   */
  async playAux(
    buffer: { channels: Float32Array[]; sampleRate: number },
    opts: { loopStart?: number; loopEnd?: number; offset?: number } = {},
  ): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!this.neutral) await this.ensureWorklet();
    this.pause();
    this.stopAux(false);
    const { channels, sampleRate } = buffer;
    const buf = ctx.createBuffer(channels.length, Math.max(1, channels[0]?.length ?? 1), sampleRate);
    channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const looping = opts.loopStart !== undefined && opts.loopEnd !== undefined;
    this.auxLoop = looping ? { start: opts.loopStart!, end: opts.loopEnd! } : null;
    this.auxDuration = buf.duration;
    this.auxBuffer = buf;
    this.startAuxSource(opts.offset ?? (looping ? opts.loopStart! : 0));
    this.emit('play');
    await new Promise<void>((resolve) => {
      this.auxDone = resolve;
    });
  }

  /** Create and start the aux source from `offset` (also used to restart it when speed/pitch routing changes). */
  private startAuxSource(offset: number): void {
    const ctx = this.getContext();
    const buf = this.auxBuffer;
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (this.auxLoop) {
      src.loop = true;
      src.loopStart = this.auxLoop.start;
      src.loopEnd = this.auxLoop.end;
    }
    this.auxStNode = this.connectSource(src);
    this.auxRate = this.speed;
    this.auxStartCtx = ctx.currentTime;
    this.auxOffset = offset;
    this.aux = src;
    src.onended = () => {
      if (this.aux !== src) return;
      this.aux = null;
      this.auxStNode?.disconnect();
      this.auxStNode = null;
      this.auxBuffer = null;
      const done = this.auxDone;
      this.auxDone = null;
      this.emit('pause');
      done?.();
    };
    src.start(0, offset);
  }

  private restartAux(offset: number): void {
    const s = this.aux;
    if (!s) return;
    this.aux = null;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
    s.disconnect();
    this.auxStNode?.disconnect();
    this.auxStNode = null;
    this.startAuxSource(offset);
  }

  /** Position inside the aux buffer, in seconds. */
  getAuxTime(): number {
    if (!this.aux || !this.ctx) return 0;
    let pos = this.auxOffset + (this.ctx.currentTime - this.auxStartCtx) * this.auxRate;
    const loop = this.auxLoop;
    if (loop && pos >= loop.end) pos = loop.start + ((pos - loop.start) % (loop.end - loop.start));
    return Math.min(pos, this.auxDuration);
  }

  stopAux(notify = true): void {
    const s = this.aux;
    if (!s) return;
    const done = this.auxDone;
    this.aux = null;
    this.auxDone = null;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
    s.disconnect();
    this.auxStNode?.disconnect();
    this.auxStNode = null;
    this.auxBuffer = null;
    done?.();
    if (notify) this.emit('pause');
  }

  isAuxPlaying(): boolean {
    return this.aux !== null;
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
    this.stNode?.disconnect();
    this.stNode = null;
  }
}
