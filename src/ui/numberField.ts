import { h } from './dom';

/** What a field needs to know about one kind of number. */
export interface NumberFieldOptions {
  /** Stable id of the input (label `for`, tests, and the id of the message under it is `${id}-msg`). */
  id: string;
  /** Accessible name. */
  label: string;
  testId?: string;
  value: number;
  /** How a value is shown. */
  format(value: number): string;
  /** Typed text to a number, or a short message saying what is wrong with it. */
  parse(text: string): number | string;
  /**
   * What the arrow keys add: a number, or a function that returns the next value. Shift multiplies it by 10 and
   * Alt divides it by 10 (`mult` is 10, 1 or 0.1).
   */
  step: number | ((value: number, dir: 1 | -1, mult: number) => number);
  /** Arrow keys stop here. Typed values outside the range are refused with a message. */
  min?: number;
  max?: number;
  /** Extra check of a parsed value; returns a message to refuse it. */
  validate?(value: number): string | null;
  /** A valid new value. Return a message to refuse it (the field keeps the old value and shows the message). */
  onCommit(value: number): string | null | void;
  inputMode?: 'decimal' | 'numeric' | 'text';
  /** Width in characters. */
  width?: number;
  /** Shown after the input (for example `x`, `ms`, `BPM`). */
  suffix?: string;
  placeholder?: string;
  className?: string;
}

let counter = 0;

/** A fresh id for fields that have no natural one. */
export function nextFieldId(prefix = 'nf'): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Decimal places that `n` is written with (1, 0.5, 0.01 -> 0, 1, 2), at most 6. */
function decimalsOf(n: number): number {
  for (let d = 0; d < 6; d++) if (Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-9) return d;
  return 6;
}

/**
 * The one text field for every number the user can adjust. It is a text input (so a value can be `1:09.600` or
 * `1.25x`, and the mouse wheel can never change it by accident) with:
 *
 * - Up and Down step the value (Shift x10, Alt /10), committing each step;
 * - Enter or blur commits what was typed, Escape puts the last value back;
 * - a value that does not parse, is out of range or is refused by the owner is never committed: the field gets a red
 *   outline (`aria-invalid`) and a short message, and keeps its old value;
 * - a visible focus state and a stable id.
 *
 * It does not draw its own slider; owners pair it with one and call `setValue` when the other changes.
 */
export class NumberField {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private message: HTMLElement;
  private unit: HTMLElement | null = null;
  private value: number;
  /** Text was edited since the last commit or `setValue`. */
  private dirty = false;

  constructor(private opts: NumberFieldOptions) {
    this.value = opts.value;
    this.input = h('input', {
      class: 'nf-input mono',
      attrs: {
        id: opts.id,
        type: 'text',
        inputmode: opts.inputMode ?? 'decimal',
        autocomplete: 'off',
        spellcheck: false,
        'aria-label': opts.label,
        'aria-describedby': `${opts.id}-msg`,
        'data-testid': opts.testId,
        placeholder: opts.placeholder,
        size: opts.width,
      },
      on: {
        input: () => {
          this.dirty = true;
          this.clearError();
        },
        keydown: (e) => this.onKey(e),
        blur: () => this.commitText(),
        // A text input ignores the wheel; say so explicitly: never step on scroll.
        wheel: () => undefined,
      },
    });
    this.input.value = opts.format(opts.value);
    this.message = h('span', { class: 'nf-msg small', attrs: { id: `${opts.id}-msg`, 'aria-live': 'polite', hidden: true } });
    if (opts.suffix) this.unit = h('span', { class: 'nf-suffix muted small', text: opts.suffix, attrs: { 'aria-hidden': 'true' } });
    this.el = h('span', { class: `numfield${opts.className ? ` ${opts.className}` : ''}` }, [
      h('span', { class: 'nf-box' }, [this.input, this.unit]),
      this.message,
    ]);
  }

  /** The last committed (or set) value. */
  get current(): number {
    return this.value;
  }

  get isInvalid(): boolean {
    return this.input.getAttribute('aria-invalid') === 'true';
  }

  /** Show a value from outside (the slider moved, the model changed). A half-typed edit is left alone. */
  setValue(value: number): void {
    const changed = value !== this.value;
    this.value = value;
    if (this.dirty) return;
    this.input.value = this.opts.format(value);
    // a message about a refused edit stays until the value really changes (or the user edits or presses Escape)
    if (changed) this.clearError();
  }

  setDisabled(disabled: boolean, title = ''): void {
    this.input.disabled = disabled;
    this.input.title = disabled ? title : '';
  }

  /** Change the limits of the arrow keys and of typed values (they depend on the song, the sample rate, ...). */
  setRange(min: number | undefined, max: number | undefined): void {
    this.opts.min = min;
    this.opts.max = max;
  }

  focus(): void {
    this.input.focus();
  }

  showError(text: string): void {
    this.input.setAttribute('aria-invalid', 'true');
    this.message.textContent = text;
    this.message.hidden = false;
  }

  clearError(): void {
    this.input.removeAttribute('aria-invalid');
    this.message.textContent = '';
    this.message.hidden = true;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitText();
    } else if (e.key === 'Escape') {
      // revert; a dialog around the field must not close on this Escape
      if (this.dirty || this.isInvalid) e.preventDefault();
      e.stopPropagation();
      this.dirty = false;
      this.input.value = this.opts.format(this.value);
      this.clearError();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.stepBy(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    }
  }

  /** Move one step from what is shown (typed text that parses, else the last value) and commit it. */
  private stepBy(dir: 1 | -1, mult: number): void {
    const typed = this.dirty ? this.opts.parse(this.input.value) : this.value;
    const base = typeof typed === 'number' ? typed : this.value;
    const { step, min, max } = this.opts;
    let next: number;
    if (typeof step === 'function') next = step(base, dir, mult);
    else {
      // keep every digit of both the step and the value (a time of 2.109 s stepped by 10 ms is 2.099, not 2.10)
      const d = Math.min(6, Math.max(decimalsOf(step * mult), decimalsOf(base)));
      next = Number((base + dir * step * mult).toFixed(d));
    }
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    this.dirty = false;
    this.commit(next);
  }

  private commitText(): void {
    if (!this.dirty) return;
    const parsed = this.opts.parse(this.input.value);
    if (typeof parsed === 'string') {
      this.showError(parsed);
      return;
    }
    this.commit(parsed);
  }

  private commit(value: number): void {
    const { min, max, validate } = this.opts;
    const range = (): string => {
      const f = this.opts.format;
      return min !== undefined && max !== undefined
        ? `Enter a value from ${f(min)} to ${f(max)}.`
        : min !== undefined
          ? `Enter ${f(min)} or more.`
          : `Enter ${f(max!)} or less.`;
    };
    const problem =
      (min !== undefined && value < min - 1e-9) || (max !== undefined && value > max + 1e-9) ? range() : (validate?.(value) ?? null);
    if (problem) {
      this.showError(problem);
      return;
    }
    const refused = this.opts.onCommit(value);
    if (typeof refused === 'string') {
      this.showError(refused);
      return;
    }
    this.value = value;
    this.dirty = false;
    this.input.value = this.opts.format(value);
    this.clearError();
  }
}

/** A number written as plain digits with an optional unit suffix, for `parse` (`1.25x`, `120 bpm`). */
export function parsePlainNumber(text: string, suffixes: readonly string[] = []): number | null {
  let t = text.trim().toLowerCase();
  for (const s of suffixes) {
    if (t.endsWith(s)) {
      t = t.slice(0, -s.length).trim();
      break;
    }
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
