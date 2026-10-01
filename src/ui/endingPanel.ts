import { MAX_FADE_SECONDS } from '../model';
import { formatClock, parseClock, roundMs } from '../util/time';
import { h } from './dom';
import { NumberField, parsePlainNumber } from './numberField';

export type EndingMode = 'real' | 'at';

export interface EndingPanelCallbacks {
  /** Choose the real ending or End at. */
  onMode(mode: EndingMode): void;
  /** Why an End at time is not allowed (the field shows it and keeps its old value), or null. */
  checkEndAt(seconds: number): string | null;
  /** Why a fade length is not allowed, or null. */
  checkFade(seconds: number): string | null;
  /** A typed End at time (on the extended timeline). Returns the reason when refused, null when applied. */
  onEndAt(seconds: number): string | null;
  /** End at = the playhead, on the extended timeline. Returns the reason when refused. */
  onEndAtPlayhead(): string | null;
  /** A typed or slid fade length in seconds. Returns the reason when refused. */
  onFade(seconds: number): string | null;
  /** Target-length mode: End at = the target length. */
  onEndAtTarget(): void;
}

export interface EndingView {
  mode: EndingMode;
  /** The End at time to show (while the real ending is chosen, the natural length of the extended song). */
  endAt: number;
  fadeSeconds: number;
  /** Length of the extended song before the end point trims it. */
  natural: number;
  /** The Length card is in target mode: offer End exactly at target. */
  targetMode: boolean;
  /** The End at time follows the target length. */
  followsTarget: boolean;
  /** A notice to show (for example that End at was reset), or null. */
  notice: string | null;
}

/** The Ending card: the real ending or End at a time on the extended timeline, and a fade-out that ends exactly there. */
export class EndingPanel {
  readonly el: HTMLElement;
  private modeInputs: Record<EndingMode, HTMLInputElement>;
  private endAt: NumberField;
  private playheadBtn: HTMLButtonElement;
  private targetBtn: HTMLButtonElement;
  private fadeField: NumberField;
  private fadeSlider: HTMLInputElement;
  private note: HTMLElement;
  private notice: HTMLElement;
  private follows: HTMLElement;

  constructor(private cb: EndingPanelCallbacks) {
    const mkMode = (mode: EndingMode, label: string): { input: HTMLInputElement; el: HTMLElement } => {
      const input = h('input', {
        attrs: { type: 'radio', name: 'ending-mode', value: mode, 'data-testid': `ending-${mode}` },
        on: { change: () => input.checked && this.cb.onMode(mode) },
      });
      return { input, el: h('label', { class: 'field' }, [input, h('span', { text: label })]) };
    };
    const real = mkMode('real', 'Real ending');
    const at = mkMode('at', 'End at');
    this.modeInputs = { real: real.input, at: at.input };

    this.endAt = new NumberField({
      id: 'end-at-input',
      label: 'End at, a time on the extended timeline (h:mm:ss.mmm)',
      testId: 'end-at-input',
      value: 0,
      format: (v) => formatClock(v),
      parse: (text) => {
        const v = parseClock(text);
        return v === null ? 'Enter a time like 14:20.000, 14:20 or 860.' : roundMs(v);
      },
      step: 0.01,
      width: 10,
      inputMode: 'text',
      validate: (v) => this.cb.checkEndAt(v),
      onCommit: (seconds) => this.cb.onEndAt(seconds),
    });
    this.playheadBtn = h('button', {
      class: 'btn sm',
      text: 'Set from playhead',
      attrs: { type: 'button', 'data-testid': 'end-at-playhead', title: 'Use the playhead of the extended song as the end point' },
      on: {
        click: () => {
          const refused = this.cb.onEndAtPlayhead();
          if (refused) this.endAt.showError(refused);
        },
      },
    });
    this.targetBtn = h('button', {
      class: 'btn sm',
      text: 'End exactly at target',
      attrs: { type: 'button', 'data-testid': 'end-at-target', hidden: true, title: 'Trim the song to exactly the target length and fade into that point' },
      on: { click: () => this.cb.onEndAtTarget() },
    });
    this.follows = h('span', { class: 'muted small', text: 'Follows the target length.', attrs: { hidden: true, 'data-testid': 'end-at-follows' } });

    this.fadeField = new NumberField({
      id: 'fade-input',
      label: 'Fade out in seconds, from 0 to 60 (0 means no fade)',
      testId: 'fade-input',
      value: 0,
      format: (v) => (Math.abs(v * 10 - Math.round(v * 10)) < 1e-9 ? v.toFixed(1) : String(v)),
      parse: (text) => {
        const n = parsePlainNumber(text, ['s', 'sec']);
        return n === null ? 'Enter seconds like 8 or 2.5.' : roundMs(n);
      },
      step: 0.1,
      min: 0,
      max: MAX_FADE_SECONDS,
      width: 5,
      suffix: 's',
      validate: (v) => this.cb.checkFade(v),
      onCommit: (seconds) => this.cb.onFade(seconds),
    });
    this.fadeSlider = h('input', {
      attrs: { type: 'range', min: 0, max: MAX_FADE_SECONDS, step: 0.1, value: 0, 'aria-label': 'Fade out (seconds)', 'data-testid': 'fade-slider' },
      on: {
        input: () => this.fadeField.setValue(Number(this.fadeSlider.value)),
        change: () => {
          const refused = this.cb.onFade(Number(this.fadeSlider.value));
          if (refused) {
            this.fadeField.showError(refused);
            this.fadeSlider.value = String(this.fadeField.current);
          }
        },
      },
    });
    this.note = h('div', { class: 'small muted', attrs: { 'data-testid': 'ending-note', role: 'status' } });
    this.notice = h('div', { class: 'small warn-text', attrs: { hidden: true, 'data-testid': 'ending-notice', role: 'status' } });

    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Ending', 'data-testid': 'ending-card' } }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Ending' }), h('span', { class: 'muted small', text: 'Where the extended song stops, and the fade into it' })]),
      h('div', { class: 'ending-row' }, [real.el, at.el, this.endAt.el, this.playheadBtn, this.targetBtn, this.follows]),
      h('div', { class: 'ending-row' }, [
        h('label', { class: 'field', attrs: { for: 'fade-input' } }, [h('span', { text: 'Fade out' })]),
        this.fadeSlider,
        this.fadeField.el,
        h('span', { class: 'muted small', text: '0 = no fade' }),
      ]),
      this.note,
      this.notice,
    ]);
  }

  update(v: EndingView): void {
    this.modeInputs.real.checked = v.mode === 'real';
    this.modeInputs.at.checked = v.mode === 'at';
    this.endAt.setValue(v.endAt);
    this.endAt.setDisabled(v.mode === 'real', 'Choose End at to type an end point');
    this.playheadBtn.disabled = v.mode === 'real';
    this.targetBtn.hidden = !v.targetMode;
    this.follows.hidden = !(v.targetMode && v.mode === 'at' && v.followsTarget);
    this.fadeField.setValue(v.fadeSeconds);
    this.fadeSlider.value = String(v.fadeSeconds);
    this.note.textContent =
      v.mode === 'at'
        ? `The extended song is ${formatClock(v.natural)} long; it stops at ${formatClock(v.endAt)}${v.fadeSeconds > 0 ? `, fading out over the last ${v.fadeSeconds} s` : ''}.`
        : v.fadeSeconds > 0
          ? `The song ends at its real ending (${formatClock(v.natural)}), fading out over the last ${v.fadeSeconds} s.`
          : `The song ends at its real ending (${formatClock(v.natural)}).`;
    this.notice.hidden = !v.notice;
    this.notice.textContent = v.notice ?? '';
  }
}
