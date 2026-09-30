import { formatTime } from '../util/time';
import { h } from './dom';

export type PlayMode = 'original' | 'extended';

export interface TransportCallbacks {
  onTogglePlay(): void;
  onMode(mode: PlayMode): void;
  onExport(): void;
}

/** Sticky transport bar: original/extended toggle, play/pause, position, export. */
export class Transport {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeEl: HTMLElement;
  private exportBtn: HTMLButtonElement;
  private modeBtns: Record<PlayMode, HTMLButtonElement>;
  private status: HTMLElement;
  /** Extra controls (speed/pitch) are appended here by the app. */
  readonly extra: HTMLElement;

  constructor(private cb: TransportCallbacks) {
    this.playBtn = h('button', {
      class: 'btn primary play',
      text: 'Play',
      attrs: { type: 'button', 'aria-label': 'Play', 'data-testid': 'play' },
      on: { click: () => this.cb.onTogglePlay() },
    });
    const mk = (mode: PlayMode, label: string): HTMLButtonElement =>
      h('button', {
        class: 'btn sm',
        text: label,
        attrs: { type: 'button', 'data-testid': `mode-${mode}`, 'aria-pressed': 'false' },
        on: { click: () => this.cb.onMode(mode) },
      });
    this.modeBtns = { original: mk('original', 'Original'), extended: mk('extended', 'Extended') };
    this.timeEl = h('span', { class: 'time', text: '0:00.0 / 0:00.0', attrs: { 'data-testid': 'time' } });
    this.status = h('span', { class: 'muted small', attrs: { 'data-testid': 'render-status', role: 'status' } });
    this.exportBtn = h('button', {
      class: 'btn',
      text: 'Export WAV…',
      attrs: { type: 'button', 'data-testid': 'export' },
      on: { click: () => this.cb.onExport() },
    });
    this.extra = h('div', { class: 'row transport-extra' });
    this.el = h('section', { class: 'transport', attrs: { 'aria-label': 'Transport' } }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Play mode' } }, [
          this.modeBtns.original,
          this.modeBtns.extended,
        ]),
        this.playBtn,
        this.timeEl,
        this.status,
        h('span', { class: 'grow' }),
        this.exportBtn,
      ]),
      this.extra,
    ]);
    this.setMode('original');
  }

  setMode(mode: PlayMode): void {
    (Object.keys(this.modeBtns) as PlayMode[]).forEach((m) => {
      this.modeBtns[m].classList.toggle('active', m === mode);
      this.modeBtns[m].setAttribute('aria-pressed', String(m === mode));
    });
  }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? 'Pause' : 'Play';
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  setTime(t: number, duration: number): void {
    this.timeEl.textContent = `${formatTime(t, 1)} / ${formatTime(duration, 1)}`;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setEnabled(enabled: boolean): void {
    this.playBtn.disabled = !enabled;
    this.exportBtn.disabled = !enabled;
    this.modeBtns.original.disabled = !enabled;
    this.modeBtns.extended.disabled = !enabled;
  }
}
