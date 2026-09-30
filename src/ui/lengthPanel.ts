import { RENDER_CONFIG } from '../audio/config';
import { formatTime, parseTime } from '../util/time';
import { h } from './dom';

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
}

/** Original -> extended length, repeat-count vs target-length mode, and the advanced seam smoothing control. */
export class LengthPanel {
  readonly el: HTMLElement;
  private original: HTMLElement;
  private extended: HTMLElement;
  private note: HTMLElement;
  private modeInputs: Record<LengthMode, HTMLInputElement>;
  private targetInput: HTMLInputElement;
  private targetRow: HTMLElement;
  private seam: HTMLInputElement;
  private seamValue: HTMLElement;

  constructor(private cb: LengthPanelCallbacks) {
    this.original = h('span', { class: 'mono big', attrs: { 'data-testid': 'length-original' } });
    this.extended = h('span', { class: 'mono big', attrs: { 'data-testid': 'length-extended' } });
    this.note = h('div', { class: 'small', attrs: { 'data-testid': 'length-note', role: 'status' } });

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

    this.targetInput = h('input', {
      class: 'num wide',
      attrs: { type: 'text', inputmode: 'numeric', placeholder: 'mm:ss', 'aria-label': 'Target length (mm:ss)', 'data-testid': 'target-input' },
      on: {
        change: () => this.commitTarget(),
        keydown: (e) => {
          if (e.key === 'Enter') this.commitTarget();
        },
      },
    });
    this.targetRow = h('div', { class: 'row' }, [
      h('label', { class: 'field' }, [h('span', { text: 'Target' }), this.targetInput]),
      h('span', { class: 'muted small', text: 'The app picks repeat counts and rounds to whole repeats.' }),
    ]);

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
        input: () => {
          this.seamValue.textContent = `${this.seam.value} ms`;
        },
        change: () => this.cb.onSeamMs(Number(this.seam.value)),
      },
    });
    this.seamValue = h('span', { class: 'mono small' });

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
        h('label', { class: 'field' }, [
          h('span', { text: 'Seam smoothing' }),
          this.seam,
          this.seamValue,
        ]),
        h('div', {
          class: 'muted small',
          text: 'Length of the equal-power crossfade at each loop jump (5 to 80 ms). It is part of the preview and the export.',
        }),
      ]),
    ]);
  }

  private commitTarget(): void {
    const s = parseTime(this.targetInput.value);
    if (s === null || s <= 0) {
      this.targetInput.setAttribute('aria-invalid', 'true');
      return;
    }
    this.targetInput.removeAttribute('aria-invalid');
    this.cb.onTarget(s);
  }

  update(v: LengthView): void {
    this.original.textContent = formatTime(v.originalSeconds);
    this.extended.textContent = formatTime(v.extendedSeconds);
    this.modeInputs.repeats.checked = v.mode === 'repeats';
    this.modeInputs.target.checked = v.mode === 'target';
    this.targetRow.hidden = v.mode !== 'target';
    if (document.activeElement !== this.targetInput) {
      this.targetInput.value = formatTime(v.targetSeconds);
      this.targetInput.removeAttribute('aria-invalid');
    }
    this.note.textContent = v.note;
    this.note.className = v.noteKind === 'warn' ? 'small warn-text' : 'small muted';
    if (Number(this.seam.value) !== v.seamMs || !this.seamValue.textContent) {
      this.seam.value = String(v.seamMs);
      this.seamValue.textContent = `${v.seamMs} ms`;
    }
  }
}
