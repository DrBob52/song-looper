import { formatTime } from '../util/time';
import { h } from './dom';

export type PlayMode = 'original' | 'extended';

export interface TransportCallbacks {
  onTogglePlay(): void;
  onMode(mode: PlayMode): void;
  onExport(): void;
  /** Speed factor (0.5..1.5, tempo only). */
  onSpeed(speed: number): void;
  /** Pitch shift in semitones (-12..12). */
  onPitch(semitones: number): void;
  onResetSpeedPitch(): void;
}

/** Sticky transport bar: original/extended toggle, play/pause, position, export. */
export class Transport {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeEl: HTMLElement;
  private exportBtn: HTMLButtonElement;
  private modeBtns: Record<PlayMode, HTMLButtonElement>;
  private status: HTMLElement;
  private speedInput: HTMLInputElement;
  private speedLabel: HTMLElement;
  private pitchLabel: HTMLElement;
  private resetBtn: HTMLButtonElement;
  private details: HTMLDetailsElement;
  private detailsSummary: HTMLElement;
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
    this.speedInput = h('input', {
      attrs: { type: 'range', min: 0.5, max: 1.5, step: 0.01, value: 1, 'aria-label': 'Speed (tempo only)', 'data-testid': 'speed' },
      on: { input: () => this.cb.onSpeed(Number(this.speedInput.value)) },
    });
    this.speedLabel = h('span', { class: 'mono small', text: '1.00x', attrs: { 'data-testid': 'speed-label' } });
    this.pitchLabel = h('span', { class: 'mono small pitch-label', text: '0', attrs: { 'data-testid': 'pitch-label' } });
    const pitchStep = (d: number, label: string, id: string): HTMLButtonElement =>
      h('button', {
        class: 'btn sm icon',
        text: d < 0 ? '\u2212' : '+',
        attrs: { type: 'button', 'aria-label': label, 'data-testid': id },
        on: { click: () => this.cb.onPitch(this.pitchValue + d) },
      });
    this.resetBtn = h('button', {
      class: 'btn sm',
      text: 'Reset',
      attrs: { type: 'button', 'data-testid': 'speed-pitch-reset', title: 'Back to original speed and pitch' },
      on: { click: () => this.cb.onResetSpeedPitch() },
    });
    this.extra = h('div', { class: 'row transport-extra' }, [
      h('label', { class: 'field speed-field' }, [h('span', { text: 'Speed' }), this.speedInput, this.speedLabel]),
      h('span', { class: 'field' }, [
        h('span', { text: 'Pitch' }),
        pitchStep(-1, 'Pitch down one semitone', 'pitch-down'),
        this.pitchLabel,
        pitchStep(1, 'Pitch up one semitone', 'pitch-up'),
        h('span', { class: 'muted small', text: 'semitones' }),
      ]),
      this.resetBtn,
    ]);
    this.detailsSummary = h('summary', { text: 'Speed & pitch' });
    this.details = h('details', { class: 'transport-details' }, [this.detailsSummary, this.extra]);
    // Wide screens show the controls; small screens start collapsed to keep the sticky bar short.
    this.details.open = window.matchMedia('(min-width: 640px)').matches;
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
      this.details,
    ]);
    this.setMode('original');
    this.setSpeedPitch(1, 0);
  }

  private pitchValue = 0;

  /** Reflect the current speed/pitch in the controls. */
  setSpeedPitch(speed: number, semitones: number): void {
    this.pitchValue = semitones;
    this.speedInput.value = String(speed);
    this.speedLabel.textContent = `${speed.toFixed(2)}x`;
    this.pitchLabel.textContent = `${semitones > 0 ? '+' : ''}${semitones}`;
    const neutral = Math.abs(speed - 1) < 1e-6 && semitones === 0;
    this.resetBtn.disabled = neutral;
    this.detailsSummary.textContent = neutral ? 'Speed & pitch' : `Speed & pitch (${speed.toFixed(2)}x, ${semitones > 0 ? '+' : ''}${semitones})`;
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

  /** Disable the speed/pitch controls when the browser has no AudioWorklet. */
  setSpeedPitchAvailable(available: boolean): void {
    this.speedInput.disabled = !available;
    for (const b of this.extra.querySelectorAll('button')) (b as HTMLButtonElement).disabled = !available;
    this.extra.title = available ? '' : 'Speed and pitch need AudioWorklet support, which this browser does not have.';
    if (!available) this.detailsSummary.textContent = 'Speed & pitch (not supported in this browser)';
  }

  setEnabled(enabled: boolean): void {
    this.playBtn.disabled = !enabled;
    this.exportBtn.disabled = !enabled;
    this.modeBtns.original.disabled = !enabled;
    this.modeBtns.extended.disabled = !enabled;
    this.speedInput.disabled = !enabled;
  }
}
