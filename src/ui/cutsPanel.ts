import type { Cut } from '../model';
import { formatTime, roundMs } from '../util/time';
import { h } from './dom';
import { createEdgeEditor } from './edgeEditor';
import type { Edge, EdgeEdit } from './edgeEditor';
import type { NumberField } from './numberField';
import { formatBars } from './regionsPanel';

export interface CutsPanelCallbacks {
  onSelect(id: string): void;
  /** Set a cut's start or end exactly. Returns a message when refused (the cut keeps its times), null when applied. */
  onEditEdge(id: string, edge: Edge, edit: EdgeEdit): string | null;
  /** Hear 4 s before the join through 4 s after it. */
  onAudition(id: string): void;
  onRemove(id: string): void;
  onHover(id: string | null): void;
}

export interface CutsPanelInfo {
  /** Seconds per bar near a cut (for the "bars" readout), or null when there is no beat grid. */
  barsOf(cut: Cut): number | null;
  /** A steady beat was found, so "beat" nudges mean something. */
  steadyBeat: boolean;
  duration: number;
}

interface Row {
  el: HTMLLIElement;
  title: HTMLElement;
  start: NumberField;
  end: NumberField;
  beatButtons: HTMLButtonElement[];
  meta: HTMLElement;
  note: HTMLElement;
}

/** The cuts: spans of the original song that the extended song skips. Rows are updated in place (keyed by id). */
export class CutsPanel {
  readonly el: HTMLElement;
  private list: HTMLUListElement;
  private empty: HTMLElement;
  private rows = new Map<string, Row>();

  constructor(private cb: CutsPanelCallbacks) {
    this.empty = h('p', {
      class: 'muted small',
      text: 'No cuts yet. Drag on the waveform to select a span to leave out, then press X or use Cut selection.',
      attrs: { 'data-testid': 'cuts-empty' },
    });
    this.list = h('ul', { class: 'cut-list', attrs: { 'data-testid': 'cuts' } });
    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Cuts', 'data-testid': 'cuts-card' } }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: 'Cuts' }),
        h('span', { class: 'muted small', text: 'Spans of the song that the extended cut skips' }),
      ]),
      this.empty,
      this.list,
    ]);
  }

  update(cuts: Cut[], selectedId: string | null, info: CutsPanelInfo): void {
    this.empty.hidden = cuts.length > 0;
    const ids = new Set(cuts.map((c) => c.id));
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
    cuts.forEach((cut, index) => {
      let row = this.rows.get(cut.id);
      if (!row) {
        row = this.createRow(cut.id);
        this.rows.set(cut.id, row);
      }
      const current = this.list.children[index];
      if (current !== row.el) this.list.insertBefore(row.el, current ?? null);
      row.el.classList.toggle('selected', cut.id === selectedId);
      row.title.textContent = `Cut ${index + 1}`;
      row.start.setValue(roundMs(cut.start));
      row.end.setValue(roundMs(cut.end));
      for (const b of row.beatButtons) b.hidden = !info.steadyBeat;
      const len = cut.end - cut.start;
      const bars = info.barsOf(cut);
      row.meta.textContent = `Length ${len.toFixed(3)} s${bars !== null ? ` · ${formatBars(bars)}` : ''}`;
      row.note.textContent =
        cut.start <= 1e-9
          ? 'Removes the intro: the extended song starts at the end of this cut (with a 10 ms fade-in).'
          : cut.end >= info.duration - 1e-9
            ? 'Removes the outro: the extended song ends at the start of this cut.'
            : `Skipped: the song joins ${formatTime(cut.start, 1)} to ${formatTime(cut.end, 1)} with a crossfade.`;
    });
  }

  private createRow(id: string): Row {
    const title = h('strong');
    const meta = h('span', { class: 'muted small mono', attrs: { 'data-testid': 'cut-length' } });
    const note = h('div', { class: 'cut-note muted small', attrs: { 'data-testid': 'cut-note' } });
    const beatButtons: HTMLButtonElement[] = [];
    const edge = (which: Edge): { el: HTMLElement; field: NumberField } =>
      createEdgeEditor({
        noun: 'cut',
        which,
        fieldId: `${id}-${which}`,
        testIds: {
          field: `cut-${which}`,
          beatDec: `cut-${which}-beat-dec`,
          msDec: `cut-${which}-ms-dec`,
          msInc: `cut-${which}-ms-inc`,
          beatInc: `cut-${which}-beat-inc`,
          playhead: `cut-${which}-playhead`,
        },
        onEdit: (edit) => this.cb.onEditEdge(id, which, edit),
        beatButtons,
      });
    const startEdge = edge('start');
    const endEdge = edge('end');
    const el = h(
      'li',
      {
        class: 'cut',
        attrs: { 'data-cut-id': id, 'data-testid': 'cut' },
        on: {
          click: () => this.cb.onSelect(id),
          mouseenter: () => this.cb.onHover(id),
          mouseleave: () => this.cb.onHover(null),
        },
      },
      [
        h('div', { class: 'cut-head' }, [h('span', { class: 'cut-glyph', text: '✂', attrs: { 'aria-hidden': 'true' } }), title, meta]),
        h('div', { class: 'cut-times' }, [startEdge.el, endEdge.el]),
        note,
        h('div', { class: 'cut-actions' }, [
          h('button', {
            class: 'btn sm quiet',
            text: 'Audition cut',
            attrs: { type: 'button', 'data-testid': 'audition-cut', title: 'Hear 4 s before the join through 4 s after it, as the export will have it' },
            on: {
              click: (e) => {
                e.stopPropagation();
                this.cb.onAudition(id);
              },
            },
          }),
          h('button', {
            class: 'btn sm quiet danger',
            text: 'Remove',
            attrs: { type: 'button', 'data-testid': 'remove-cut' },
            on: {
              click: (e) => {
                e.stopPropagation();
                this.cb.onRemove(id);
              },
            },
          }),
        ]),
      ],
    );
    return { el, title, start: startEdge.field, end: endEdge.field, beatButtons, meta, note };
  }
}
