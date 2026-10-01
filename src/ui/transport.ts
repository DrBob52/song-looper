import { formatTime } from '../util/time';
import { h } from './dom';
import { NumberField, parsePlainNumber } from './numberField';

export type PlayMode = 'original' | 'extended';

export interface TransportCallbacks {
  onTogglePlay(): void;
  onMode(mode: PlayMode): void;
  onExport(): void;
  /** Speed factor (0.5..1.5, tempo only). */
  onSpeed(speed: number): void;
  /** Pitch shift in semitones (-12..12, decimals allowed). */
  onPitch(semitones: number): void;
  onResetSpeedPitch(): void;
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;
export const PITCH_MIN = -12;
export const PITCH_MAX = 12;

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;

/** Sticky transport bar: play/pause, original/extended toggle, position, speed and pitch, export. */
export class Transport {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private playWord: HTMLElement;
  private timeEl: HTMLElement;
  private exportBtn: HTMLButtonElement;
  private modeBtns: Record<PlayMode, HTMLButtonElement>;
  private status: HTMLElement;
  private speedInput: HTMLInputElement;
  private speedField: NumberField;
  private pitchField: NumberField;
  private speedLabel: HTMLElement;
  private pitchLabel: HTMLElement;
  private resetBtn: HTMLButtonElement;
  private details: HTMLDetailsElement;
  private detailsSummary: HTMLElement;
  /** Extra controls (speed/pitch) are appended here by the app. */
  readonly extra: HTMLElement;
  private speedPitchAvailable = true;
  private exportBlockedReason: string | null = null;

  constructor(private cb: TransportCallbacks) {
    // The big round button: a disc with a drawn triangle or pause bars, and the word beside it.
    this.playWord = h('span', { class: 'play-word', text: 'Play' });
    this.playBtn = h(
      'button',
      {
        class: 'play',
        attrs: { type: 'button', 'aria-pressed': 'false', 'data-testid': 'play', title: 'Play or pause (Space)' },
        on: { click: () => this.cb.onTogglePlay() },
      },
      [h('span', { class: 'play-disc', attrs: { 'aria-hidden': 'true' } }, [h('span', { class: 'play-glyph' })]), this.playWord],
    );
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
      class: 'btn export',
      text: 'Export WAV…',
      attrs: { type: 'button', 'data-testid': 'export' },
      on: { click: () => this.cb.onExport() },
    });

    this.speedInput = h('input', {
      attrs: { type: 'range', min: SPEED_MIN, max: SPEED_MAX, step: 0.01, value: 1, 'aria-label': 'Speed (tempo only)', 'data-testid': 'speed' },
      on: { input: () => this.cb.onSpeed(Number(this.speedInput.value)) },
    });
    this.speedField = new NumberField({
      id: 'speed-input',
      label: 'Speed, from 0.50 to 1.50 (tempo only)',
      testId: 'speed-input',
      value: 1,
      format: (v) => v.toFixed(2),
      parse: (text) => {
        const n = parsePlainNumber(text, ['x']);
        return n === null ? 'Enter a speed like 1.25 or 1.25x.' : n;
      },
      step: 0.01,
      min: SPEED_MIN,
      max: SPEED_MAX,
      width: 5,
      suffix: 'x',
      onCommit: (v) => this.cb.onSpeed(v),
    });
    // The text readouts stay for assistive technology and tests; the fields above are what people type in.
    this.speedLabel = h('span', { class: 'sr-only', text: '1.00x', attrs: { 'data-testid': 'speed-label' } });
    this.pitchLabel = h('span', { class: 'sr-only', text: '0', attrs: { 'data-testid': 'pitch-label' } });
    this.pitchField = new NumberField({
      id: 'pitch-input',
      label: 'Pitch in semitones, from -12 to +12',
      testId: 'pitch-input',
      value: 0,
      format: (v) => signed(Number(v.toFixed(2))),
      parse: (text) => {
        const n = parsePlainNumber(text.replace(/−/g, '-'));
        return n === null ? 'Enter semitones like -1.5 or +2.' : n;
      },
      step: 0.1,
      min: PITCH_MIN,
      max: PITCH_MAX,
      width: 5,
      onCommit: (v) => this.cb.onPitch(v),
    });
    const pitchStep = (d: number, label: string, id: string): HTMLButtonElement =>
      h('button', {
        class: 'btn sm icon',
        text: d < 0 ? '−' : '+',
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
      h('span', { class: 'field speed-field' }, [
        h('label', { text: 'Speed', attrs: { for: 'speed-input' } }),
        this.speedInput,
        this.speedField.el,
        this.speedLabel,
      ]),
      h('span', { class: 'field' }, [
        h('label', { text: 'Pitch', attrs: { for: 'pitch-input' } }),
        pitchStep(-1, 'Pitch down one semitone', 'pitch-down'),
        this.pitchField.el,
        pitchStep(1, 'Pitch up one semitone', 'pitch-up'),
        this.pitchLabel,
        h('span', { class: 'muted small', text: 'semitones' }),
      ]),
      this.resetBtn,
    ]);
    this.detailsSummary = h('summary', { text: 'Speed & pitch' });
    this.details = h('details', { class: 'transport-details' }, [this.detailsSummary, this.extra]);
    // Wide screens show the controls; small screens start collapsed to keep the sticky bar short.
    this.details.open = window.matchMedia('(min-width: 640px)').matches;
    this.el = h('section', { class: 'transport', attrs: { 'aria-label': 'Transport' } }, [
      h('div', { class: 'row transport-main' }, [
        this.playBtn,
        this.timeEl,
        this.status,
        h('span', { class: 'grow' }),
        h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Play mode' } }, [
          this.modeBtns.original,
          this.modeBtns.extended,
        ]),
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
    this.speedField.setValue(speed);
    this.pitchField.setValue(semitones);
    this.speedLabel.textContent = `${speed.toFixed(2)}x`;
    this.pitchLabel.textContent = signed(Number(semitones.toFixed(2)));
    const neutral = Math.abs(speed - 1) < 1e-6 && semitones === 0;
    this.resetBtn.disabled = neutral;
    this.detailsSummary.textContent = neutral
      ? 'Speed & pitch'
      : `Speed & pitch (${speed.toFixed(2)}x, ${signed(Number(semitones.toFixed(2)))})`;
  }

  setMode(mode: PlayMode): void {
    (Object.keys(this.modeBtns) as PlayMode[]).forEach((m) => {
      this.modeBtns[m].classList.toggle('active', m === mode);
      this.modeBtns[m].setAttribute('aria-pressed', String(m === mode));
    });
  }

  setPlaying(playing: boolean): void {
    this.playWord.textContent = playing ? 'Pause' : 'Play';
    this.playBtn.setAttribute('aria-pressed', String(playing));
    this.playBtn.classList.toggle('playing', playing);
  }

  setTime(t: number, duration: number): void {
    this.timeEl.textContent = `${formatTime(t, 1)} / ${formatTime(duration, 1)}`;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Disable the speed/pitch controls when the browser has no AudioWorklet. */
  setSpeedPitchAvailable(available: boolean): void {
    this.speedPitchAvailable = available;
    this.speedInput.disabled = !available;
    this.speedField.setDisabled(!available);
    this.pitchField.setDisabled(!available);
    for (const b of this.extra.querySelectorAll('button')) (b as HTMLButtonElement).disabled = !available;
    this.extra.title = available ? '' : 'Speed and pitch need AudioWorklet support, which this browser does not have.';
    if (!available) this.detailsSummary.textContent = 'Speed & pitch (not supported in this browser)';
  }

  setEnabled(enabled: boolean): void {
    this.playBtn.disabled = !enabled;
    this.exportBtn.disabled = !enabled || this.exportBlockedReason !== null;
    this.modeBtns.original.disabled = !enabled;
    this.modeBtns.extended.disabled = !enabled;
    const on = enabled && this.speedPitchAvailable;
    this.speedInput.disabled = !on;
    this.speedField.setDisabled(!on);
    this.pitchField.setDisabled(!on);
  }

  /** Disable Export with the reason (a length that cannot fit in a WAV), or enable it again with `null`. */
  setExportBlocked(reason: string | null): void {
    this.exportBlockedReason = reason;
    this.exportBtn.disabled = reason !== null || this.playBtn.disabled;
    this.exportBtn.title = reason ?? '';
    if (reason) this.exportBtn.setAttribute('aria-describedby', 'length-note');
    else this.exportBtn.removeAttribute('aria-describedby');
  }
}
