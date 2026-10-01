import { RENDER_CONFIG } from '../audio/config';
import { formatClock, formatTime, parseClock, roundMs } from '../util/time';
import { h } from './dom';
import { NumberField, parsePlainNumber } from './numberField';

export type LengthMode = 'repeats' | 'target';

export interface LengthPanelCallbacks {
  onMode(mode: LengthMode): void;
  onTarget(seconds: number): void;
  onSeamMs(ms: number): void;
}

export interface LengthView {
  mode: LengthMode;
  targetSeconds: number;
  originalSeconds: number;
  extendedSeconds: number;
  seamMs: number;
  note: string;
  noteKind: 'info' | 'warn';
  hasRegions: boolean;
  /** The longest extended song a WAV can hold, in seconds (Infinity: no limit known), and what to say about a longer one. */
  capSeconds: number;
  capMessage: string;
}

/** Original -> extended length, repeat-count vs target-length mode, and the advanced seam smoothing control. */
export class LengthPanel {
  readonly el: HTMLElement;
  private original: HTMLElement;
  private extended: HTMLElement;
  private note: HTMLElement;
  private modeInputs: Record<LengthMode, HTMLInputElement>;
  private target: NumberField;
  private targetRow: HTMLElement;
  private seam: HTMLInputElement;
  private seamField: NumberField;
  private capSeconds = Infinity;
  private capMessage = '';

  constructor(private cb: LengthPanelCallbacks) {
    this.original = h('span', { class: 'mono big', attrs: { 'data-testid': 'length-original' } });
    this.extended = h('span', { class: 'mono big', attrs: { 'data-testid': 'length-extended' } });
    this.note = h('div', { class: 'small', attrs: { id: 'length-note', 'data-testid': 'length-note', role: 'status' } });

    const mkMode = (mode: LengthMode, label: string): { input: HTMLInputElement; el: HTMLElement } => {
      const input = h('input', {
        attrs: { type: 'radio', name: 'length-mode', value: mode, 'data-testid': `length-mode-${mode}` },
        on: { change: () => input.checked && this.cb.onMode(mode) },
      });
      return { input, el: h('label', { class: 'field' }, [input, h('span', { text: label })]) };
    };
    const a = mkMode('repeats', 'Repeat counts');
    const b = mkMode('target', 'Target length');
    this.modeInputs = { repeats: a.input, target: b.input };

    this.target = new NumberField({
      id: 'target-length',
      label: 'Target length (h:mm:ss or m:ss)',
      testId: 'target-input',
      value: 0,
      format: (v) => formatClock(v, 0),
      parse: (text) => {
        const v = parseClock(text);
        if (v === null) return 'Enter a length like 3:30 or 1:05:00.';
        return v <= 0 ? 'The target must be longer than zero.' : roundMs(v);
      },
      // one second per press (Shift: ten seconds)
      step: (v, dir, mult) => Math.max(1, Math.round(v) + dir * (mult >= 10 ? 10 : 1)),
      width: 8,
      inputMode: 'text',
      placeholder: 'm:ss',
      validate: (v) => (v > this.capSeconds ? this.capMessage : null),
      onCommit: (seconds) => this.cb.onTarget(seconds),
    });
    this.targetRow = h('div', { class: 'row' }, [
      h('label', { class: 'field', attrs: { for: 'target-length' } }, [h('span', { text: 'Target' })]),
      this.target.el,
      h('span', { class: 'muted small', text: 'The app picks repeat counts and rounds to whole repeats.' }),
    ]);

    this.seamField = new NumberField({
      id: 'seam-smoothing-input',
      label: 'Seam smoothing in milliseconds',
      testId: 'seam-smoothing-input',
      value: RENDER_CONFIG.crossfadeMs,
      format: (v) => String(v),
      parse: (text) => {
        const n = parsePlainNumber(text, ['ms']);
        return n === null ? 'Enter milliseconds, like 20.' : Math.round(n);
      },
      step: 1,
      min: RENDER_CONFIG.crossfadeMinMs,
      max: RENDER_CONFIG.crossfadeMaxMs,
      width: 4,
      suffix: 'ms',
      onCommit: (ms) => {
        this.seam.value = String(ms);
        this.cb.onSeamMs(ms);
      },
    });
    this.seam = h('input', {
      attrs: {
        type: 'range',
        min: RENDER_CONFIG.crossfadeMinMs,
        max: RENDER_CONFIG.crossfadeMaxMs,
        step: 1,
        'aria-label': 'Seam smoothing (ms)',
        'data-testid': 'seam-smoothing',
      },
      on: {
        input: () => this.seamField.setValue(Number(this.seam.value)),
        change: () => this.cb.onSeamMs(Number(this.seam.value)),
      },
    });

    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Length' } }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Length' }), h('div', { class: 'row' }, [a.el, b.el])]),
      h('div', { class: 'row' }, [
        this.original,
        h('span', { class: 'muted', text: '→' }),
        this.extended,
        h('span', { class: 'muted small', text: 'original → extended' }),
      ]),
      this.targetRow,
      this.note,
      h('details', { class: 'advanced' }, [
        h('summary', { text: 'Advanced' }),
        h('div', { class: 'field' }, [
          h('label', { text: 'Seam smoothing', attrs: { for: 'seam-smoothing-input' } }),
          this.seam,
          this.seamField.el,
        ]),
        h('div', {
          class: 'muted small',
          text: 'Length of the equal-power crossfade at each loop jump (5 to 80 ms). It is part of the preview and the export.',
        }),
      ]),
    ]);
  }

  update(v: LengthView): void {
    this.original.textContent = formatTime(v.originalSeconds);
    this.extended.textContent = formatTime(v.extendedSeconds);
    this.modeInputs.repeats.checked = v.mode === 'repeats';
    this.modeInputs.target.checked = v.mode === 'target';
    this.targetRow.hidden = v.mode !== 'target';
    this.capSeconds = v.capSeconds;
    this.capMessage = v.capMessage;
    this.target.setValue(v.targetSeconds);
    this.note.textContent = v.note;
    this.note.className = v.noteKind === 'warn' ? 'small warn-text' : 'small muted';
    this.seam.value = String(v.seamMs);
    this.seamField.setValue(v.seamMs);
  }
}
