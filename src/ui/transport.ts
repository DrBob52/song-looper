import { formatTime } from '../util/time';
import { h } from './dom';

export interface TransportCallbacks {
  onTogglePlay(): void;
}

/** Sticky transport bar: play/pause and position. Grows speed/pitch and mode controls later. */
export class Transport {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeEl: HTMLElement;

  constructor(private cb: TransportCallbacks) {
    this.playBtn = h('button', {
      class: 'btn primary',
      text: 'Play',
      attrs: { type: 'button', 'aria-label': 'Play', 'data-testid': 'play' },
      on: { click: () => this.cb.onTogglePlay() },
    });
    this.timeEl = h('span', { class: 'time', text: '0:00.0 / 0:00.0', attrs: { 'data-testid': 'time' } });
    this.el = h('section', { class: 'transport', attrs: { 'aria-label': 'Transport' } }, [
      h('div', { class: 'row' }, [this.playBtn, this.timeEl]),
    ]);
  }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? 'Pause' : 'Play';
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  setTime(t: number, duration: number): void {
    this.timeEl.textContent = `${formatTime(t, 1)} / ${formatTime(duration, 1)}`;
  }

  setEnabled(enabled: boolean): void {
    this.playBtn.disabled = !enabled;
  }
}
