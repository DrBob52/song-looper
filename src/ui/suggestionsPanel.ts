import type { Analysis, LoopCandidate } from '../analysis/types';
import type { LoopRegion } from '../model';
import { formatTime } from '../util/time';
import { formatBars } from './regionsPanel';
import { clear, h } from './dom';

export interface SuggestionsCallbacks {
  onPreview(index: number): void;
  onAuditionSeam(index: number): void;
  onAdd(index: number): void;
  onHover(index: number | null): void;
}

export interface SuggestionsView {
  analysis: Analysis | null;
  running: boolean;
  failed: boolean;
  regions: LoopRegion[];
  /** Key of the span being previewed (see suggestionKey). */
  previewingKey: string | null;
  duration: number;
}

const VISIBLE_DEFAULT = 8;

export const suggestionKey = (index: number): string => `sug-${index}`;

export function starString(stars: number): string {
  return '★'.repeat(stars) + '☆'.repeat(5 - stars);
}

/** Ranked loop suggestions with preview, seam audition and add buttons. */
export class SuggestionsPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private showAll = false;

  constructor(private cb: SuggestionsCallbacks) {
    this.body = h('div');
    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Suggested loops', 'data-testid': 'suggestions' } }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Suggested loops' })]),
      this.body,
    ]);
  }

  update(view: SuggestionsView): void {
    clear(this.body);
    const a = view.analysis;
    const note = (text: string, cls = 'muted small'): void => {
      this.body.append(h('p', { class: cls, text, attrs: { 'data-testid': 'suggestions-note' } }));
    };
    if (view.running && !a) return note('Analysing the song…');
    if (view.failed && !a) return note('Analysis failed, so there are no suggestions. You can still add loops by hand.');
    if (!a) return note('Load a song to see suggestions.');
    if (a.skipped === 'silent') return note('This file looks silent, so there are no suggestions.');
    if (a.skipped === 'short')
      return note('This song is under 20 seconds, so suggestions are skipped. Drag on the waveform and press L to add a loop by hand.');
    if (a.skipped === 'no-beats')
      return note('No beats were found, so there are no suggestions. You can still add loops by hand.');
    if (a.candidates.length === 0) return note('No loops scored well enough to suggest. You can still add loops by hand.');

    if (!a.steadyBeat) note('No steady beat found. Suggestions may be rough.', 'small warn-text');
    const list = h('ol', { class: 'suggestion-list' });
    const visible = this.showAll ? a.candidates.length : Math.min(a.candidates.length, VISIBLE_DEFAULT);
    a.candidates.slice(0, visible).forEach((c, i) => list.append(this.row(c, i, view)));
    this.body.append(list);
    if (a.candidates.length > VISIBLE_DEFAULT) {
      this.body.append(
        h('button', {
          class: 'btn sm more',
          text: this.showAll ? 'Show fewer' : `Show all ${a.candidates.length}`,
          attrs: { type: 'button', 'data-testid': 'suggestions-more' },
          on: {
            click: () => {
              this.showAll = !this.showAll;
              this.update(view);
            },
          },
        }),
      );
    }
  }

  private row(c: LoopCandidate, index: number, view: SuggestionsView): HTMLElement {
    const same = view.regions.find((r) => Math.abs(r.start - c.start) < 0.05 && Math.abs(r.end - c.end) < 0.05);
    const overlap = same
      ? null
      : view.regions.find((r) => r.start < c.end - 1e-6 && r.end > c.start + 1e-6);
    const previewing = view.previewingKey === suggestionKey(index);
    const addBtn = h('button', {
      class: 'btn sm primary',
      text: same ? 'Added' : 'Add',
      attrs: {
        type: 'button',
        'data-testid': 'suggestion-add',
        title: same ? 'Already in your loops' : overlap ? 'Overlaps one of your loops; it will be trimmed to fit' : 'Add to your loops',
      },
      on: { click: () => this.cb.onAdd(index) },
    });
    addBtn.disabled = Boolean(same);
    return h(
      'li',
      {
        class: 'suggestion',
        attrs: { 'data-testid': 'suggestion', 'data-index': index },
        on: {
          mouseenter: () => this.cb.onHover(index),
          mouseleave: () => this.cb.onHover(null),
          focusin: () => this.cb.onHover(index),
          focusout: () => this.cb.onHover(null),
        },
      },
      [
        h('div', { class: 'suggestion-rank', text: String(index + 1) }),
        h('div', { class: 'suggestion-main' }, [
          h('div', { class: 'suggestion-title' }, [
            h('span', { class: 'mono', text: `${formatTime(c.start, 1)} – ${formatTime(c.end, 1)}` }),
            h('span', { class: 'muted small', text: `${formatBars(c.bars)} · ${(c.end - c.start).toFixed(1)} s` }),
            h('span', {
              class: 'stars',
              text: starString(c.stars),
              attrs: { 'aria-label': `${c.stars} of 5 stars`, title: `Score ${(c.score * 100).toFixed(0)}%` },
            }),
          ]),
          h('div', { class: 'small suggestion-reason', text: c.reason }),
          h('div', { class: 'suggestion-actions' }, [
            h('button', {
              class: `btn sm${previewing ? ' active' : ''}`,
              text: previewing ? 'Stop' : 'Preview',
              attrs: { type: 'button', 'data-testid': 'suggestion-preview', title: 'Hear this loop repeating' },
              on: { click: () => this.cb.onPreview(index) },
            }),
            h('button', {
              class: 'btn sm',
              text: 'Audition seam',
              attrs: { type: 'button', 'data-testid': 'suggestion-seam', title: 'Hear the jump from the loop end back to its start' },
              on: { click: () => this.cb.onAuditionSeam(index) },
            }),
            addBtn,
          ]),
        ]),
      ],
    );
  }
}
