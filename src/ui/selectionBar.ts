import type { Span } from '../model';
import { formatClock, parseClock, roundMs } from '../util/time';
import { h } from './dom';
import { NumberField } from './numberField';
import { formatBars } from './regionsPanel';
import type { Edge } from './edgeEditor';

export interface SelectionBarCallbacks {
  /** A typed (or stepped) start or end of the selection, exact and never snapped. Returns the reason when refused, null when applied. */
  onEdit(edge: Edge, seconds: number): string | null;
  /** Add as loop (L). */
  onAddLoop(): void;
  /** Cut (X). */
  onCut(): void;
  /** Clear (Esc): the selection goes away. */
  onClear(): void;
}

/** What the bar needs to know to describe a selection. */
export interface SelectionBarInfo {
  /** Bars in the span near it, or null when there is no beat grid. */
  barsOf(span: Span): number | null;
}

/** "2.400 s · 1.2 bars" (the bars when there is a beat grid). */
export function describeLength(span: Span, bars: number | null): string {
  const seconds = Math.max(0, span.end - span.start);
  return `${seconds.toFixed(3)} s${bars !== null ? ` · ${formatBars(bars)}` : ''}`;
}

/**
 * The selection bar (SPEC-v1.3.md 7.2): while a span is selected on the waveform it sits right under it, with the span's
 * Start and End as time fields (typed values move the selection at once; they are exact and never snapped, with the loop
 * fields' parsing and messages), its length in seconds and bars, and Add as loop (L), Cut (X) and Clear. Hidden when
 * there is no selection.
 */
export class SelectionBar {
  readonly el: HTMLElement;
  readonly start: NumberField;
  readonly end: NumberField;
  private length: HTMLElement;

  constructor(private cb: SelectionBarCallbacks) {
    const field = (which: Edge): NumberField => {
      const label = which === 'start' ? 'Start' : 'End';
      const field: NumberField = new NumberField({
        id: `selection-${which}`,
        label: `${label} time of the selection`,
        testId: `selection-${which}`,
        value: 0,
        format: (v) => formatClock(v),
        parse: (text) => {
          const v = parseClock(text);
          return v === null ? 'Enter a time like 1:09.600, 1:09 or 69.6.' : roundMs(v);
        },
        step: 0.01,
        width: 10,
        inputMode: 'text',
        onCommit: (seconds) => this.cb.onEdit(which, seconds),
      });
      return field;
    };
    this.start = field('start');
    this.end = field('end');
    this.length = h('span', { class: 'mono sel-length-value', attrs: { 'data-testid': 'selection-length' } });
    const edge = (which: Edge, f: NumberField): HTMLElement =>
      h('div', { class: 'sel-edge' }, [
        h('label', { class: 'edge-label muted small', text: which === 'start' ? 'Start' : 'End', attrs: { for: `selection-${which}` } }),
        f.el,
      ]);
    this.el = h('div', { class: 'selection-bar', attrs: { hidden: true, role: 'group', 'aria-label': 'Selection', 'data-testid': 'selection-bar' } }, [
      edge('start', this.start),
      edge('end', this.end),
      h('div', { class: 'sel-length' }, [h('span', { class: 'edge-label muted small', text: 'Length' }), this.length]),
      h('div', { class: 'sel-actions' }, [
        h('button', {
          class: 'btn sm primary',
          text: 'Add as loop',
          attrs: { type: 'button', 'data-testid': 'selection-add-loop', title: 'Add the selection as a loop (L)', 'aria-keyshortcuts': 'L' },
          on: { click: () => this.cb.onAddLoop() },
        }),
        h('button', {
          class: 'btn sm',
          text: '✂ Cut',
          attrs: { type: 'button', 'data-testid': 'selection-cut', title: 'Cut the selection out of the extended song (X)', 'aria-keyshortcuts': 'X' },
          on: { click: () => this.cb.onCut() },
        }),
        h('button', {
          class: 'btn sm quiet',
          text: 'Clear',
          attrs: { type: 'button', 'data-testid': 'selection-clear', title: 'Clear the selection (Esc)', 'aria-keyshortcuts': 'Escape' },
          on: { click: () => this.cb.onClear() },
        }),
      ]),
    ]);
  }

  /** Show the selection (or hide the bar when there is none). */
  update(selection: Span | null, info: SelectionBarInfo): void {
    this.el.hidden = selection === null;
    if (!selection) return;
    this.start.setValue(roundMs(selection.start));
    this.end.setValue(roundMs(selection.end));
    this.length.textContent = describeLength(selection, info.barsOf(selection));
  }
}
