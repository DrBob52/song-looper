/** Seconds per turn at 1.00x: 33 1/3 rpm is 1.8 s a turn. */
export const SECONDS_PER_TURN = 1.8;
const SPIN_UP_MS = 400;
const LABEL_DROP_MS = 150;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The spin of the record on the turntable bar. While playing it turns once every 1.8 s / speed (33 1/3 rpm times the
 * playback speed); paused, it stops where it is and starts again from there, never snapping back. Starting from stopped
 * is a "needle drop": the label scales from 0.96 to 1 over 150 ms and the spin eases in over 400 ms. With
 * `prefers-reduced-motion` it does not turn at all.
 */
export class RecordSpin {
  private anim: Animation | null = null;
  private playing = false;
  private speed = 1;
  private ramp = 0;

  constructor(
    private disc: HTMLElement,
    private label: HTMLElement,
  ) {}

  setSpeed(speed: number): void {
    this.speed = speed;
    if (this.playing && this.anim && !this.ramp) this.anim.updatePlaybackRate(speed);
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    cancelAnimationFrame(this.ramp);
    this.ramp = 0;
    if (reducedMotion()) {
      this.anim?.cancel();
      this.anim = null;
      return;
    }
    if (!this.anim) {
      this.anim = this.disc.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
        duration: SECONDS_PER_TURN * 1000,
        iterations: Infinity,
        easing: 'linear',
      });
      this.anim.pause();
    }
    const anim = this.anim;
    if (!playing) {
      anim.pause();
      return;
    }
    // needle drop: the label settles while the record spins up
    this.label.animate([{ transform: 'scale(0.96)' }, { transform: 'scale(1)' }], { duration: LABEL_DROP_MS, easing: 'ease-out' });
    const start = performance.now();
    anim.playbackRate = 0.02;
    anim.play();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / SPIN_UP_MS);
      if (t >= 1) {
        this.ramp = 0;
        anim.playbackRate = this.speed;
        return;
      }
      anim.playbackRate = Math.max(0.02, this.speed * t * t);
      this.ramp = requestAnimationFrame(step);
    };
    this.ramp = requestAnimationFrame(step);
  }
}
