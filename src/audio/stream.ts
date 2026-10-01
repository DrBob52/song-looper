/**
 * Live playback of a song that is too long to hold in memory (SPEC-v1.2.md 2.3): the extended song is rendered a few
 * seconds at a time and played as back-to-back AudioBufferSourceNodes on one context, a few chunks ahead of the
 * playhead. Works on any BaseAudioContext, so a test can run the very same scheduler on an OfflineAudioContext.
 */

/** Where the audio comes from: any stretch of a (possibly hours-long) song, rendered on demand. */
export interface ChunkSource {
  readonly sampleRate: number;
  readonly channels: number;
  /** Frames in the whole song. */
  readonly totalFrames: number;
  /** Frames [start, start + frames) as one array per channel. */
  fetch(start: number, frames: number): Promise<Float32Array[]>;
}

export interface ChunkStreamOptions {
  /** Seconds of audio per chunk (default 5). */
  chunkSeconds?: number;
  /** How many chunks are kept scheduled ahead (default 3). */
  aheadChunks?: number;
  /** Seconds between "now" and the first sound when playback starts or catches up (default 0.03). */
  leadSeconds?: number;
}

export const STREAM_DEFAULTS = { chunkSeconds: 5, aheadChunks: 3, leadSeconds: 0.03 } as const;

/**
 * Frames of the next chunk that each chunk's buffer carries beyond its own end (but never plays: the source is told to
 * stop at the join). A context at another sample rate resamples with an interpolator that reads a frame or two past
 * the one it outputs; without them, the last output frame of every chunk would read silence or a repeat of the final
 * sample, which is an audible tick at each join.
 */
export const STREAM_GUARD_FRAMES = 16;

interface Scheduled {
  /** The first frame this entry plays (a chunk's first frame, or later for the chunk a seek landed in). */
  first: number;
  frames: number;
  /** Context time of its first sound and of its end. */
  when: number;
  end: number;
  src: AudioBufferSourceNode;
}

/**
 * Schedules consecutive chunks at exact times: chunk k + 1 starts at the very instant chunk k ends
 * (`when + frames / (sampleRate x rate)`, accumulated from the one start time, never re-read from the clock), so
 * there is no gap at a join. The chunk length is a whole number of seconds, so at rate 1 each chunk is a whole number
 * of frames of the context too, whatever the sample rates are.
 *
 * All chunk sources feed `output`, which is where the SoundTouch node sits when speed or pitch is changed. A change
 * of rate means a new stream from the current position.
 */
export class ChunkStream {
  readonly chunkFrames: number;
  private queue: Scheduled[] = [];
  private generation = 0;
  private running = false;
  private rate = 1;
  /** First frame not scheduled yet, and the context time it should start at. */
  private nextFrame = 0;
  private nextWhen = 0;
  /** The frame after the last entry that finished playing. */
  private playedUpTo = 0;
  /** The running refill loop, if any: there is at most one, so two never schedule the same chunk. */
  private pumpPromise: Promise<void> | null = null;
  /** Keep scheduling until playback time (context seconds) is covered up to here; for offline rendering. */
  private fillUntil = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lead: number;
  private ahead: number;
  /** Called once when the last frame has played. */
  onEnded: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  constructor(
    private ctx: BaseAudioContext,
    private output: AudioNode,
    private source: ChunkSource,
    opts: ChunkStreamOptions = {},
  ) {
    this.chunkFrames = Math.max(1, Math.round((opts.chunkSeconds ?? STREAM_DEFAULTS.chunkSeconds) * source.sampleRate));
    this.ahead = Math.max(1, opts.aheadChunks ?? STREAM_DEFAULTS.aheadChunks);
    this.lead = opts.leadSeconds ?? STREAM_DEFAULTS.leadSeconds;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Frames of chunks scheduled and not yet finished (for tests). */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Start playing at `frame` with the sources' playbackRate set to `rate`, first sound at context time `when` (default:
   * a moment from now). Resolves when the first chunk is scheduled; the rest follows in the background. Playing from
   * the middle of a chunk starts that chunk at the right offset: a seek restarts the queue from the chunk that holds
   * the target.
   */
  async start(frame: number, rate: number, when?: number): Promise<void> {
    this.stop();
    const gen = ++this.generation;
    this.running = true;
    this.fillUntil = -Infinity;
    this.rate = rate;
    this.nextFrame = Math.max(0, Math.min(this.source.totalFrames, Math.floor(frame)));
    this.playedUpTo = this.nextFrame;
    this.nextWhen = when ?? this.ctx.currentTime + this.lead;
    if (this.nextFrame >= this.source.totalFrames) {
      this.finish(gen);
      return;
    }
    await this.scheduleNext(gen);
    if (gen !== this.generation) return;
    void this.pump();
    // a live context needs refilling as playback goes; an offline one is filled by `fill` before it renders
    if (!('startRendering' in this.ctx)) this.timer = setInterval(() => void this.pump(), 200);
  }

  /** Stop at once and let go of everything scheduled. */
  stop(): void {
    this.running = false;
    this.generation++;
    this.pumpPromise = null; // an old loop ends by itself (its generation is gone); a new one may start at once
    this.clearTimer();
    for (const e of this.queue) this.release(e);
    this.queue = [];
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private release(e: Scheduled): void {
    e.src.onended = null;
    try {
      e.src.stop();
    } catch {
      /* not started or already stopped */
    }
    e.src.disconnect();
  }

  /**
   * Where playback is, in frames of the song. In a gap (the render was late) that is where playback will pick up;
   * before the first sound it is where it starts.
   */
  position(): number {
    const t = this.ctx.currentTime;
    for (const e of this.queue) {
      if (t < e.when) return e.first;
      if (t < e.end) return Math.min(this.source.totalFrames, e.first + (t - e.when) * this.source.sampleRate * this.rate);
    }
    const last = this.queue[this.queue.length - 1];
    return last ? last.first + last.frames : this.playedUpTo;
  }

  /** Schedule chunks until everything up to context time `until` is covered (or the song ends). For offline rendering. */
  async fill(until: number): Promise<void> {
    this.fillUntil = until;
    const gen = this.generation;
    while (this.running && gen === this.generation && this.nextFrame < this.source.totalFrames && this.nextWhen < until) {
      await this.pump();
    }
  }

  /** The one loop that schedules chunks while fewer than `ahead` are queued (or a `fill` asks for more). */
  private pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    if (!this.running) return Promise.resolve();
    const gen = this.generation;
    const run = async (): Promise<void> => {
      try {
        while (
          this.running &&
          gen === this.generation &&
          this.nextFrame < this.source.totalFrames &&
          (this.queue.length < this.ahead || this.nextWhen < this.fillUntil)
        ) {
          await this.scheduleNext(gen);
        }
      } catch (err) {
        if (gen === this.generation) this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const promise: Promise<void> = run().finally(() => {
      if (this.pumpPromise === promise) this.pumpPromise = null;
    });
    this.pumpPromise = promise;
    return promise;
  }

  /** Fetch the chunk that holds `nextFrame` and schedule the rest of it right after what is already scheduled. */
  private async scheduleNext(gen: number): Promise<void> {
    const total = this.source.totalFrames;
    const sr = this.source.sampleRate;
    const index = Math.floor(this.nextFrame / this.chunkFrames);
    const chunkStart = index * this.chunkFrames;
    const chunkLen = Math.min(this.chunkFrames, total - chunkStart);
    const guard = Math.min(STREAM_GUARD_FRAMES, total - (chunkStart + chunkLen));
    const data = await this.source.fetch(chunkStart, chunkLen + guard);
    if (gen !== this.generation || !this.running) return;
    const buffer = this.ctx.createBuffer(data.length, chunkLen + guard, sr);
    data.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const skip = this.nextFrame - chunkStart;
    const frames = chunkLen - skip;
    // exactly where the previous chunk ends; only when the render was late and that time has (nearly) passed is it moved
    let when = this.nextWhen;
    const now = this.ctx.currentTime;
    if (now > 0 && when < now + 0.005) when = now + this.lead;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.output);
    const entry: Scheduled = { first: this.nextFrame, frames, when, end: when + frames / (sr * this.rate), src };
    src.onended = () => {
      if (gen !== this.generation) return;
      this.queue = this.queue.filter((e) => e !== entry);
      this.playedUpTo = entry.first + entry.frames;
      src.disconnect();
      if (this.nextFrame >= total && this.queue.length === 0) this.finish(gen);
      else void this.pump();
    };
    // The guard frames are never played: the source is stopped at the instant the next chunk starts. (A `duration`
    // argument would also end the resampler's view of the buffer there; a stop time leaves it the frames beyond.)
    src.start(when, skip / sr);
    src.stop(entry.end);
    this.queue.push(entry);
    this.nextFrame += frames;
    this.nextWhen = entry.end;
  }

  private finish(gen: number): void {
    if (gen !== this.generation) return;
    this.running = false;
    this.clearTimer();
    this.playedUpTo = this.source.totalFrames;
    this.onEnded?.();
  }
}
