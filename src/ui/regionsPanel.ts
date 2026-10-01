import type { SeamReport } from '../analysis/types';
import type { LoopRegion } from '../model';
import { MAX_REPEATS } from '../model';
import { formatTime } from '../util/time';
import { h } from './dom';
import { chipLabel, chipTitle } from './seamText';

export interface RegionsPanelCallbacks {
  onAdd(): void;
  onSelect(id: string): void;
  onRepeats(id: string, repeats: number): void;
  onSnapToggle(id: string, snapToBars: boolean): void;
  onPreviewLoop(id: string): void;
  onAuditionSeam(id: string): void;
  onRemove(id: string): void;
  onHover(id: string | null): void;
}

export interface RegionsPanelInfo {
  /** Seconds per bar near a region (for the "bars" readout), or null when there is no beat grid. */
  barsOf(region: LoopRegion): number | null;
  hasGrid: boolean;
  /** Id of the region whose loop preview is playing. */
  previewingId: string | null;
  /** Repeat counts are computed from a target length, so the steppers are read-only. */
  repeatsLocked: boolean;
  /** The seam report of a region, once the analysis worker has delivered it. */
  seamOf(region: LoopRegion): SeamReport | null;
}

interface Row {
  el: HTMLLIElement;
  swatch: HTMLElement;
  title: HTMLElement;
  times: HTMLElement;
  meta: HTMLElement;
  repeats: HTMLInputElement;
  dec: HTMLButtonElement;
  inc: HTMLButtonElement;
  snap: HTMLInputElement;
  loopBtn: HTMLButtonElement;
  seam: HTMLElement;
  chip: HTMLElement;
}

/** The user's loop regions, each with its own repeat count. Rows are updated in place (keyed by id). */
export class RegionsPanel {
  readonly el: HTMLElement;
  private list: HTMLUListElement;
  private empty: HTMLElement;
  private addBtn: HTMLButtonElement;
  private rows = new Map<string, Row>();

  constructor(private cb: RegionsPanelCallbacks) {
    this.addBtn = h('button', {
      class: 'btn sm',
      text: '+ Add loop',
      attrs: { type: 'button', 'data-testid': 'add-loop', title: 'Add a loop at the selection (L)' },
      on: { click: () => this.cb.onAdd() },
    });
    this.empty = h('p', {
      class: 'muted small',
      text: 'No loops yet. Drag on the waveform to select a span, then press L or use Add loop.',
      attrs: { 'data-testid': 'regions-empty' },
    });
    this.list = h('ul', { class: 'region-list', attrs: { 'data-testid': 'regions' } });
    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Loop regions' } }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Your loops' }), this.addBtn]),
      this.empty,
      this.list,
    ]);
  }

  setEnabled(enabled: boolean): void {
    this.addBtn.disabled = !enabled;
  }

  update(regions: LoopRegion[], selectedId: string | null, info: RegionsPanelInfo): void {
    this.empty.hidden = regions.length > 0;
    const ids = new Set(regions.map((r) => r.id));
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
    regions.forEach((region, index) => {
      let row = this.rows.get(region.id);
      if (!row) {
        row = this.createRow(region.id);
        this.rows.set(region.id, row);
      }
      // keep DOM order equal to region order
      const current = this.list.children[index];
      if (current !== row.el) this.list.insertBefore(row.el, current ?? null);

      row.el.classList.toggle('selected', region.id === selectedId);
      row.swatch.style.background = region.color;
      row.title.textContent = `Loop ${index + 1}`;
      row.times.textContent = `${formatTime(region.start, 1)} – ${formatTime(region.end, 1)}`;
      const len = region.end - region.start;
      const bars = info.barsOf(region);
      row.meta.textContent = `${len.toFixed(1)} s${bars !== null ? ` · ${formatBars(bars)}` : ''}`;
      if (document.activeElement !== row.repeats) row.repeats.value = String(region.repeats);
      row.repeats.disabled = info.repeatsLocked;
      row.dec.disabled = info.repeatsLocked;
      row.inc.disabled = info.repeatsLocked;
      row.repeats.title = info.repeatsLocked ? 'Set by the target length' : '';
      row.snap.checked = region.snapToBars !== false;
      row.snap.disabled = !info.hasGrid;
      row.snap.title = info.hasGrid ? 'Snap edges to bars (off: snap to beats). Shift-drag to ignore.' : 'Snapping needs beat analysis';
      const report = info.seamOf(region);
      row.seam.hidden = !report;
      if (report) {
        row.chip.textContent = chipLabel(report.chip);
        row.chip.dataset.chip = report.chip;
        row.chip.className = `chip chip-${report.chip}`;
        row.chip.title = chipTitle(report);
        row.chip.setAttribute('aria-label', `Seam: ${chipLabel(report.chip)}`);
      }
      const previewing = info.previewingId === region.id;
      row.loopBtn.textContent = previewing ? 'Stop' : 'Loop';
      row.loopBtn.classList.toggle('active', previewing);
    });
  }

  private createRow(id: string): Row {
    const swatch = h('span', { class: 'swatch' });
    const title = h('strong');
    const times = h('span', { class: 'mono' });
    const meta = h('span', { class: 'muted small' });
    const repeats = h('input', {
      attrs: { type: 'number', min: 1, max: MAX_REPEATS, step: 1, 'aria-label': 'Repeat count', 'data-testid': 'repeats' },
      class: 'num',
    });
    const commit = (): void => {
      const n = Math.round(Number(repeats.value));
      if (Number.isFinite(n)) this.cb.onRepeats(id, Math.min(MAX_REPEATS, Math.max(1, n)));
    };
    repeats.addEventListener('change', commit);
    repeats.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
    });
    const step = (d: number): void => {
      const n = Math.round(Number(repeats.value)) || 1;
      this.cb.onRepeats(id, Math.min(MAX_REPEATS, Math.max(1, n + d)));
    };
    const dec = h('button', {
      class: 'btn sm icon',
      text: '−',
      attrs: { type: 'button', 'aria-label': 'Fewer repeats', 'data-testid': 'repeats-dec' },
      on: { click: () => step(-1) },
    });
    const inc = h('button', {
      class: 'btn sm icon',
      text: '+',
      attrs: { type: 'button', 'aria-label': 'More repeats', 'data-testid': 'repeats-inc' },
      on: { click: () => step(1) },
    });
    const snap = h('input', {
      attrs: { type: 'checkbox', 'data-testid': 'snap-toggle' },
      on: { change: () => this.cb.onSnapToggle(id, snap.checked) },
    });
    const loopBtn = h('button', {
      class: 'btn sm',
      text: 'Loop',
      attrs: { type: 'button', 'data-testid': 'loop-preview', title: 'Hear this loop repeating' },
      on: { click: () => this.cb.onPreviewLoop(id) },
    });
    const seamBtn = h('button', {
      class: 'btn sm',
      text: 'Audition seam',
      attrs: { type: 'button', 'data-testid': 'audition-seam', title: 'Hear the jump from the loop end back to its start' },
      on: { click: () => this.cb.onAuditionSeam(id) },
    });
    const chip = h('span', { class: 'chip', attrs: { 'data-testid': 'seam-chip' } });
    const seam = h('span', { class: 'seam-status', attrs: { hidden: true } }, [
      h('span', { class: 'muted small', text: 'Seam' }),
      chip,
    ]);
    const removeBtn = h('button', {
      class: 'btn sm danger',
      text: 'Remove',
      attrs: { type: 'button', 'data-testid': 'remove-loop' },
      on: { click: () => this.cb.onRemove(id) },
    });
    const el = h(
      'li',
      {
        class: 'region',
        attrs: { 'data-region-id': id },
        on: {
          click: () => this.cb.onSelect(id),
          mouseenter: () => this.cb.onHover(id),
          mouseleave: () => this.cb.onHover(null),
        },
      },
      [
        swatch,
        h('div', { class: 'region-main' }, [
          h('div', { class: 'region-title' }, [title, times, meta, seam]),
          h('div', { class: 'region-controls' }, [
            h('span', { class: 'field' }, [h('span', { text: 'Repeats' }), dec, repeats, inc]),
            h('label', { class: 'field' }, [snap, h('span', { text: 'Snap to bars' })]),
            h('span', { class: 'spacer' }),
            loopBtn,
            seamBtn,
            removeBtn,
          ]),
        ]),
      ],
    );
    return { el, swatch, title, times, meta, repeats, dec, inc, snap, loopBtn, seam, chip };
  }
}

export function formatBars(bars: number): string {
  const rounded = Math.round(bars * 10) / 10;
  return `${rounded} bar${rounded === 1 ? '' : 's'}`;
}
