import type { NearbyLoop, SeamReport } from '../analysis/types';
import type { LoopRegion } from '../model';
import { MAX_REPEATS } from '../model';
import { currentSeam } from '../audio/path';
import { isSmooth } from '../plan';
import { formatClock, formatTime, parseClock, roundMs } from '../util/time';
import { h } from './dom';
import { holdRepeat } from './holdRepeat';
import { NumberField, parsePlainNumber } from './numberField';
import { chipLabel, chipTitle, seamSummary } from './seamText';

/** One way of moving a loop's start or end to an exact time. */
export type EdgeEdit =
  | { type: 'time'; seconds: number }
  /** Add `delta` seconds (a nudge). */
  | { type: 'ms'; delta: number }
  /** One analysed beat earlier or later. */
  | { type: 'beat'; dir: 1 | -1 }
  /** The current playback position of the original song. */
  | { type: 'playhead' };

export type Edge = 'start' | 'end';

export interface RegionsPanelCallbacks {
  onAdd(): void;
  onSelect(id: string): void;
  onRepeats(id: string, repeats: number): void;
  /**
   * Set a loop's start or end exactly. Returns a message when the edit is refused (the loop keeps its times), and
   * null when it was applied.
   */
  onEditEdge(id: string, edge: Edge, edit: EdgeEdit): string | null;
  onSnapToggle(id: string, snapToBars: boolean): void;
  onPreviewLoop(id: string): void;
  onAuditionSeam(id: string): void;
  /** Play the raw seam (the loop as the user set it, no smoothing, no bridge) for A/B comparison. */
  onAuditionOriginal(id: string): void;
  onSmoothToggle(id: string, on: boolean): void;
  /** Bridge (SPEC-seams.md 5): play 1 to 4 bars of the song after the loop end, then jump back where its chord change occurs. */
  onBridgeToggle(id: string, on: boolean): void;
  /** Restore the original seam and turn smoothing off for the loop. */
  onUndoSeam(id: string): void;
  /** Hear the seam of the nearby loop with a cleaner chord change. */
  onNearbyAudition(id: string): void;
  /** Replace the loop's points with the nearby loop's. */
  onNearbyUse(id: string): void;
  onRemove(id: string): void;
  onHover(id: string | null): void;
}

export interface RegionsPanelInfo {
  /** Seconds per bar near a region (for the "bars" readout), or null when there is no beat grid. */
  barsOf(region: LoopRegion): number | null;
  hasGrid: boolean;
  /** A steady beat was found, so "beat" nudges mean something. */
  steadyBeat: boolean;
  /** Id of the region whose loop preview is playing. */
  previewingId: string | null;
  /** Repeat counts are computed from a target length, so the steppers are read-only. */
  repeatsLocked: boolean;
  /** The seam report of a region, once the analysis worker has delivered it. */
  seamOf(region: LoopRegion): SeamReport | null;
  /** A loop nearby with a cleaner chord change, if the seam report found one. */
  nearbyOf(region: LoopRegion): NearbyLoop | null;
  /** The outcome of the bridge search for a loop (null: no report for the current switches yet). */
  bridgeOf(region: LoopRegion): SeamReport['bridge'];
}

interface Row {
  el: HTMLLIElement;
  swatch: HTMLElement;
  title: HTMLElement;
  start: NumberField;
  end: NumberField;
  beatButtons: HTMLButtonElement[];
  meta: HTMLElement;
  exactNotice: HTMLElement;
  repeats: NumberField;
  dec: HTMLButtonElement;
  inc: HTMLButtonElement;
  snap: HTMLInputElement;
  loopBtn: HTMLButtonElement;
  loopLabel: HTMLElement;
  seam: HTMLElement;
  chip: HTMLElement;
  smooth: HTMLInputElement;
  summary: HTMLElement;
  summaryText: HTMLElement;
  undo: HTMLButtonElement;
  nearby: HTMLElement;
  nearbyText: HTMLElement;
  bridge: HTMLInputElement;
  bridgeStatus: HTMLElement;
  bridgeHint: HTMLElement;
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
      row.start.setValue(roundMs(region.start));
      row.end.setValue(roundMs(region.end));
      for (const b of row.beatButtons) b.hidden = !info.steadyBeat;
      const len = region.end - region.start;
      const bars = info.barsOf(region);
      row.meta.textContent = `Length ${len.toFixed(3)} s${bars !== null ? ` · ${formatBars(bars)}` : ''}`;
      row.exactNotice.hidden = !(region.exact === true && region.smooth === false);
      row.repeats.setValue(region.repeats);
      row.repeats.setDisabled(info.repeatsLocked, 'Set by the target length');
      row.dec.disabled = info.repeatsLocked;
      row.inc.disabled = info.repeatsLocked;
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
      const smooth = isSmooth(region);
      row.smooth.checked = smooth;
      const plan = currentSeam(region);
      row.summary.hidden = !(smooth && plan);
      if (smooth && plan) row.summaryText.textContent = seamSummary(plan);
      row.bridge.checked = region.bridge === true;
      const bridgeInfo = currentSeam(region)?.bridge ?? null;
      const outcome = info.bridgeOf(region);
      row.bridgeStatus.hidden = region.bridge !== true;
      if (region.bridge === true) {
        row.bridgeStatus.textContent =
          bridgeInfo && region.seam
            ? `Bridge: ${formatBars(bridgeInfo.bars)} from ${formatTime(bridgeInfo.from, 1)}, back at ${formatTime(bridgeInfo.chordChangeAt, 1)} (chord change found there)`
            : outcome === 'none'
              ? 'No natural bridge found'
              : outcome === 'unneeded'
                ? 'No bridge needed: the chord change back to the start is already natural'
                : 'Looking for a bridge\u2026';
        row.bridgeStatus.dataset.state = bridgeInfo && region.seam ? 'found' : (outcome ?? 'pending');
      }
      // the hint of last resort: a Rough seam that has not tried a bridge yet
      row.bridgeHint.hidden = !(report && report.chip === 'rough' && region.bridge !== true);
      const nearby = info.nearbyOf(region);
      row.nearby.hidden = !nearby;
      if (nearby) {
        row.nearbyText.textContent = `Cleaner chord change nearby: ${formatTime(nearby.start, 1)}\u2013${formatTime(nearby.end, 1)} (${formatBars(nearby.bars)})`;
      }
      const previewing = info.previewingId === region.id;
      row.loopLabel.textContent = previewing ? 'Stop' : 'Loop';
      row.loopBtn.classList.toggle('active', previewing);
      row.loopBtn.setAttribute('aria-pressed', String(previewing));
      row.loopBtn.title = previewing ? 'Stop the loop' : 'Hear this loop repeating';
    });
  }

  private createRow(id: string): Row {
    const swatch = h('span', { class: 'swatch' });
    const title = h('strong');
    const meta = h('span', { class: 'muted small mono', attrs: { 'data-testid': 'loop-length' } });
    const exactNotice = h('div', {
      class: 'exact-notice small',
      text: 'Smooth seam is off so the loop plays exactly these times. Turn it back on to let it move the join.',
      attrs: { hidden: true, 'data-testid': 'loop-exact-notice', role: 'status' },
    });
    const beatButtons: HTMLButtonElement[] = [];
    const edge = (which: Edge, label: string): { el: HTMLElement; field: NumberField } => {
      const field: NumberField = new NumberField({
        id: `loop-${id}-${which}`,
        label: `${label} time of this loop`,
        testId: `loop-${which}`,
        value: 0,
        format: (v) => formatClock(v),
        parse: (text) => {
          const v = parseClock(text);
          return v === null ? 'Enter a time like 1:09.600, 1:09 or 69.6.' : roundMs(v);
        },
        step: 0.01,
        width: 10,
        inputMode: 'text',
        onCommit: (seconds) => this.cb.onEditEdge(id, which, { type: 'time', seconds }),
      });
      const apply = (edit: EdgeEdit): void => {
        const refused = this.cb.onEditEdge(id, which, edit);
        if (refused) field.showError(refused);
      };
      const btn = (text: string, aria: string, testId: string, edit: EdgeEdit, beat = false): HTMLButtonElement => {
        const b = h('button', {
          class: 'btn sm nudge',
          text,
          attrs: { type: 'button', 'aria-label': aria, title: aria, 'data-testid': testId },
          on: {
            click: (e) => {
              e.stopPropagation();
              apply(edit);
            },
          },
        });
        if (beat) beatButtons.push(b);
        return b;
      };
      const el = h('div', { class: 'edge', attrs: { role: 'group', 'aria-label': `${label} of the loop` } }, [
        h('label', { class: 'edge-label muted small', text: label, attrs: { for: `loop-${id}-${which}` } }),
        field.el,
        h('span', { class: 'nudges' }, [
          btn('\u2212beat', `${label} one beat earlier`, `${which}-beat-dec`, { type: 'beat', dir: -1 }, true),
          btn('\u221210 ms', `${label} 10 milliseconds earlier`, `${which}-ms-dec`, { type: 'ms', delta: -0.01 }),
          btn('+10 ms', `${label} 10 milliseconds later`, `${which}-ms-inc`, { type: 'ms', delta: 0.01 }),
          btn('+beat', `${label} one beat later`, `${which}-beat-inc`, { type: 'beat', dir: 1 }, true),
        ]),
        h('button', {
          class: 'btn sm',
          text: 'Set from playhead',
          attrs: { type: 'button', 'data-testid': `${which}-playhead`, title: `Use the playhead as the ${which} (${which === 'start' ? 'I' : 'O'})` },
          on: {
            click: (e) => {
              e.stopPropagation();
              apply({ type: 'playhead' });
            },
          },
        }),
      ]);
      return { el, field };
    };
    const startEdge = edge('start', 'Start');
    const endEdge = edge('end', 'End');
    const repeats: NumberField = new NumberField({
      id: `loop-${id}-repeats`,
      label: 'Repeat count',
      testId: 'repeats',
      value: 1,
      format: (v) => String(v),
      parse: (text) => {
        const n = parsePlainNumber(text);
        return n === null || !Number.isInteger(n) ? 'Enter a whole number.' : n;
      },
      step: 1,
      min: 1,
      max: MAX_REPEATS,
      width: 5,
      inputMode: 'numeric',
      className: 'repeats-field',
      onCommit: (n) => this.cb.onRepeats(id, n),
    });
    // - and + step by one; holding a button repeats, and speeds up the longer it is held
    const step = (d: number): void => {
      this.cb.onRepeats(id, Math.min(MAX_REPEATS, Math.max(1, repeats.current + d)));
    };
    const dec = h('button', {
      class: 'btn sm icon',
      text: '\u2212',
      attrs: { type: 'button', 'aria-label': 'Fewer repeats', 'data-testid': 'repeats-dec' },
    });
    const inc = h('button', {
      class: 'btn sm icon',
      text: '+',
      attrs: { type: 'button', 'aria-label': 'More repeats', 'data-testid': 'repeats-inc' },
    });
    holdRepeat(dec, (size) => step(-size));
    holdRepeat(inc, (size) => step(size));
    const snap = h('input', {
      attrs: { type: 'checkbox', 'data-testid': 'snap-toggle' },
      on: { change: () => this.cb.onSnapToggle(id, snap.checked) },
    });
    const loopLabel = h('span', { class: 'sr-only', text: 'Loop' });
    const loopBtn = h(
      'button',
      {
        class: 'loop-play',
        attrs: { type: 'button', 'data-testid': 'loop-preview', title: 'Hear this loop repeating', 'aria-pressed': 'false' },
        on: {
          click: (e) => {
            e.stopPropagation();
            this.cb.onPreviewLoop(id);
          },
        },
      },
      [h('span', { class: 'play-glyph', attrs: { 'aria-hidden': 'true' } }), loopLabel],
    );
    const seamBtn = h('button', {
      class: 'btn sm',
      text: 'Audition seam',
      attrs: { type: 'button', 'data-testid': 'audition-seam', title: 'Hear the jump from the loop end back to its start, as the export will have it' },
      on: { click: () => this.cb.onAuditionSeam(id) },
    });
    const smooth = h('input', {
      attrs: { type: 'checkbox', 'data-testid': 'smooth-toggle', checked: true },
      on: { change: () => this.cb.onSmoothToggle(id, smooth.checked) },
    });
    const summaryText = h('span', { attrs: { 'data-testid': 'seam-summary' } });
    const undo = h('button', {
      class: 'btn sm',
      text: 'Undo',
      attrs: {
        type: 'button',
        'data-testid': 'seam-undo',
        title: 'Go back to the seam as it was: smoothing is turned off for this loop',
      },
      on: { click: () => this.cb.onUndoSeam(id) },
    });
    const summary = h('div', { class: 'seam-summary small', attrs: { hidden: true } }, [summaryText, undo]);
    const bridge = h('input', {
      attrs: { type: 'checkbox', 'data-testid': 'bridge-toggle' },
      on: { change: () => this.cb.onBridgeToggle(id, bridge.checked) },
    });
    const bridgeStatus = h('div', { class: 'bridge-status small', attrs: { hidden: true, 'data-testid': 'bridge-status' } });
    const bridgeHint = h('div', { class: 'bridge-hint small', attrs: { hidden: true, 'data-testid': 'bridge-hint' } }, [
      'Seam sounds rough? Try Bridge',
    ]);
    const nearbyText = h('span', { attrs: { 'data-testid': 'nearby-text' } });
    const nearby = h('div', { class: 'nearby small', attrs: { hidden: true, 'data-testid': 'nearby' } }, [
      nearbyText,
      h('button', {
        class: 'btn sm',
        text: 'Audition',
        attrs: { type: 'button', 'data-testid': 'nearby-audition', title: 'Hear the seam of that loop' },
        on: { click: () => this.cb.onNearbyAudition(id) },
      }),
      h('button', {
        class: 'btn sm primary',
        text: 'Use',
        attrs: { type: 'button', 'data-testid': 'nearby-use', title: 'Use that loop instead of this one' },
        on: { click: () => this.cb.onNearbyUse(id) },
      }),
    ]);
    const originalBtn = h('button', {
      class: 'btn sm',
      text: 'Hear original',
      attrs: {
        type: 'button',
        'data-testid': 'audition-original',
        title: 'Play the seam as you set it, without smoothing, to compare',
      },
      on: { click: () => this.cb.onAuditionOriginal(id) },
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
          h('div', { class: 'region-title' }, [loopBtn, title, seam]),
          h('div', { class: 'region-times' }, [startEdge.el, endEdge.el, meta]),
          exactNotice,
          h('div', { class: 'region-controls' }, [
            h('span', { class: 'field' }, [h('span', { text: 'Repeats' }), dec, repeats.el, inc]),
            h('label', { class: 'field' }, [snap, h('span', { text: 'Snap to bars' })]),
            h('label', { class: 'field', attrs: { title: 'Move the seam by up to a beat, line up the end, pick the fade and match levels' } }, [
              smooth,
              h('span', { text: 'Smooth seam' }),
            ]),
            h(
              'label',
              {
                class: 'field',
                attrs: { title: 'Play 1 to 4 bars of the song after the loop end, then jump back from where its chord change occurs' },
              },
              [bridge, h('span', { text: 'Bridge' })],
            ),
            h('span', { class: 'spacer' }),
            seamBtn,
            originalBtn,
            removeBtn,
          ]),
          summary,
          bridgeStatus,
          bridgeHint,
          nearby,
        ]),
      ],
    );
    return { el, swatch, title, start: startEdge.field, end: endEdge.field, beatButtons, meta, exactNotice, repeats, dec, inc, snap, loopBtn, loopLabel, seam, chip, smooth, summary, summaryText, undo, nearby, nearbyText, bridge, bridgeStatus, bridgeHint };
  }
}

export function formatBars(bars: number): string {
  const rounded = Math.round(bars * 10) / 10;
  return `${rounded} bar${rounded === 1 ? '' : 's'}`;
}
