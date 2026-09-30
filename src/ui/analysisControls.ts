import type { Analysis } from '../analysis/types';
import { h } from './dom';

export interface AnalysisControlsCallbacks {
  /** `null` returns to the automatic tempo. */
  onTempo(bpm: number | null): void;
  onMeter(beatsPerBar: number): void;
  onShiftBar(delta: number): void;
}

const METERS: [string, number][] = [
  ['4/4', 4],
  ['3/4', 3],
  ['6/8', 6],
];

const fmtBpm = (bpm: number): string => `${(Math.round(bpm * 10) / 10).toFixed(1)} BPM`;

/** Tempo override, meter, bar-line nudge, and the beat-confidence message. */
export class AnalysisControls {
  readonly el: HTMLElement;
  private tempoSelect: HTMLSelectElement;
  private meterSelect: HTMLSelectElement;
  private shiftLeft: HTMLButtonElement;
  private shiftRight: HTMLButtonElement;
  private message: HTMLElement;
  private controls: HTMLElement;

  constructor(private cb: AnalysisControlsCallbacks) {
    this.tempoSelect = h('select', {
      attrs: { 'aria-label': 'Tempo', 'data-testid': 'tempo-select' },
      on: {
        change: () => {
          const v = this.tempoSelect.value;
          this.cb.onTempo(v === 'auto' ? null : Number(v));
        },
      },
    });
    this.meterSelect = h('select', {
      attrs: { 'aria-label': 'Beats per bar', 'data-testid': 'meter-select' },
      on: { change: () => this.cb.onMeter(Number(this.meterSelect.value)) },
    });
    for (const [label, n] of METERS) this.meterSelect.append(h('option', { text: label, attrs: { value: n } }));
    this.shiftLeft = h('button', {
      class: 'btn sm icon',
      text: '◀',
      attrs: { type: 'button', 'aria-label': 'Shift bar line one beat earlier', title: 'Shift bar line earlier', 'data-testid': 'bar-shift-left' },
      on: { click: () => this.cb.onShiftBar(-1) },
    });
    this.shiftRight = h('button', {
      class: 'btn sm icon',
      text: '▶',
      attrs: { type: 'button', 'aria-label': 'Shift bar line one beat later', title: 'Shift bar line later', 'data-testid': 'bar-shift-right' },
      on: { click: () => this.cb.onShiftBar(1) },
    });
    this.message = h('div', { class: 'small', attrs: { 'data-testid': 'analysis-message', role: 'status' } });
    this.controls = h('div', { class: 'row analysis-row' }, [
      h('label', { class: 'field' }, [h('span', { text: 'Tempo' }), this.tempoSelect]),
      h('label', { class: 'field' }, [h('span', { text: 'Meter' }), this.meterSelect]),
      h('span', { class: 'field' }, [h('span', { text: 'Shift bar line' }), this.shiftLeft, this.shiftRight]),
    ]);
    this.el = h('div', { class: 'analysis-controls', attrs: { hidden: true } }, [this.controls, this.message]);
  }

  /** Show/refresh for an analysis; `null` hides the controls. */
  update(analysis: Analysis | null, busy: boolean): void {
    if (!analysis || analysis.silent || analysis.beats.length < 2) {
      this.el.hidden = !analysis;
      this.controls.hidden = true;
      this.setMessage(analysis);
      return;
    }
    this.el.hidden = false;
    this.controls.hidden = false;
    this.setMessage(analysis);

    this.tempoSelect.replaceChildren();
    const opts: [string, string][] = [];
    const cur = analysis.bpm;
    opts.push([String(cur), `${fmtBpm(cur)}${analysis.bpmOverride === null ? ' (auto)' : ''}`]);
    opts.push([String(cur / 2), `${fmtBpm(cur / 2)} (half)`]);
    if (cur * 2 <= 260) opts.push([String(cur * 2), `${fmtBpm(cur * 2)} (double)`]);
    const isNear = (a: number, b: number): boolean => Math.abs(a - b) / b < 0.06;
    if (analysis.bpmOverride !== null) {
      opts.push(['auto', `Auto (${fmtBpm(analysis.bpmAlt)})`]);
    } else if (![cur / 2, cur * 2].some((x) => isNear(analysis.bpmAlt, x)) && analysis.bpmAlt > 0) {
      opts.push([String(analysis.bpmAlt), `${fmtBpm(analysis.bpmAlt)} (alt)`]);
    }
    for (const [value, label] of opts) this.tempoSelect.append(h('option', { text: label, attrs: { value } }));
    this.tempoSelect.selectedIndex = 0;
    const meter = METERS.find(([, n]) => n === analysis.beatsPerBar);
    this.meterSelect.value = String(meter ? meter[1] : 4);
    for (const el of [this.tempoSelect, this.meterSelect, this.shiftLeft, this.shiftRight]) el.disabled = busy;
  }

  private setMessage(analysis: Analysis | null): void {
    let text = '';
    let cls = 'small muted';
    if (analysis) {
      if (analysis.silent) {
        text = 'This file looks silent, so there is nothing to analyse. You can still add loops by hand.';
        cls = 'small warn-text';
      } else if (analysis.beats.length < 8) {
        text = 'No beats found. Snapping uses a fixed 0.5 s grid.';
        cls = 'small warn-text';
      } else if (!analysis.steadyBeat) {
        text = 'No steady beat found. Suggestions may be rough. Snapping uses a fixed 0.5 s grid.';
        cls = 'small warn-text';
      }
    }
    this.message.textContent = text;
    this.message.className = cls;
    this.message.hidden = !text;
  }
}
