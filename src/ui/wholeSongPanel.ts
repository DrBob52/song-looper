import type { Analysis, WholeSongOption } from '../analysis/types';
import type { Cut, LoopRegion } from '../model';
import { isWholeSong, wholeSongConflicts } from '../plan';
import type { WholeSongConflicts } from '../plan';
import { formatClock, formatTime } from '../util/time';
import { clear, h } from './dom';
import { starString } from './suggestionsPanel';

export interface WholeSongCallbacks {
  /** Hear the jump from near the end back to the start (4 s before the end point, then 4 s from the start point). */
  onAudition(index: number): void;
  /** Add the option as a loop (the loops it replaces have been confirmed by now). */
  onUse(index: number): void;
  onHover(index: number | null): void;
}

export interface WholeSongView {
  analysis: Analysis | null;
  running: boolean;
  failed: boolean;
  regions: LoopRegion[];
  cuts: Cut[];
  duration: number;
}

/** "Loop 1", "Loop 1 and Loop 2", "Loop 1, Loop 2 and Loop 3". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The note under an option that would replace loops: "This replaces Loop 1 and Loop 2". */
export function replaceText(loops: WholeSongConflicts['loops']): string {
  return `This replaces ${joinList(loops.map((l) => `Loop ${l.number}`))}`;
}

/** The note under an option that a cut blocks: "Remove the cut at 1:40.000 first". */
export function cutBlockText(cuts: Cut[]): string {
  return `Remove the ${cuts.length === 1 ? 'cut' : 'cuts'} at ${joinList(cuts.map((c) => formatClock(c.start)))} first`;
}

/** Why there is no option to offer for this song (SPEC-v1.4.md 3), or null when there are options. */
export function wholeSongNote(view: Pick<WholeSongView, 'analysis' | 'running' | 'failed'>): string | null {
  const a = view.analysis;
  if (view.running && !a) return 'Analysing the song…';
  if (view.failed && !a) return 'Analysis failed, so there are no whole-song options. You can still add a loop by hand.';
  if (!a) return 'Load a song first.';
  if (a.wholeSong.length > 0) return null;
  if (a.skipped === 'silent') return 'This file looks silent, so there is nothing to loop.';
  if (a.skipped === 'short') return 'The song is too short to loop as a whole';
  const hand = 'Drag a selection from just after the intro to just before the outro and press L.';
  if (a.skipped === 'no-beats' || !a.steadyBeat) return `No steady beat found. ${hand}`;
  return `No way of looping this whole song sounded natural. ${hand}`;
}

/**
 * "Loop the whole song" (SPEC-v1.4.md 3): the options for tying the song's end back to its beginning, inline in the
 * Your loops card. Each one can be auditioned (the jump) and used (added as a loop with 2 plays); an option that would
 * replace loops asks first, in the panel itself, and one that has a cut inside it is disabled until the cut is removed.
 */
export class WholeSongPanel {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private body: HTMLElement;
  private open = false;
  /** The option that is waiting for the user to confirm that it replaces loops. */
  private pending: number | null = null;
  private last: WholeSongView | null = null;

  constructor(private cb: WholeSongCallbacks) {
    this.button = h('button', {
      class: 'btn sm',
      text: '↻ Whole song',
      attrs: {
        type: 'button',
        'data-testid': 'whole-song',
        'aria-expanded': 'false',
        'aria-controls': 'whole-song-panel',
        title: 'Loop the whole song: tie its end back to its beginning, so each play is almost the full song',
      },
      on: { click: () => this.setOpen(!this.open) },
    });
    this.body = h('div', { class: 'whole-body' });
    this.el = h(
      'div',
      { class: 'whole-panel', attrs: { id: 'whole-song-panel', 'data-testid': 'whole-song-panel', hidden: true, role: 'region', 'aria-label': 'Loop the whole song' } },
      [this.body],
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    this.button.classList.toggle('active', open);
    if (!open) this.pending = null;
    if (open && this.last) this.render();
  }

  update(view: WholeSongView): void {
    this.last = view;
    if (this.open) this.render();
  }

  private render(): void {
    const view = this.last;
    if (!view) return;
    clear(this.body);
    this.body.append(
      h('p', {
        class: 'whole-intro small',
        text: 'Ties the end of the song back to its beginning, so the end of one play runs into the start of the next and each play is almost the full song.',
      }),
    );
    const note = wholeSongNote(view);
    if (note) {
      this.pending = null;
      this.body.append(h('p', { class: 'whole-note small', text: note, attrs: { 'data-testid': 'whole-song-note' } }));
      return;
    }
    const options = view.analysis!.wholeSong;
    const list = h('ol', { class: 'whole-list' });
    options.forEach((o, i) => list.append(this.row(o, i, view)));
    this.body.append(list);
  }

  private row(o: WholeSongOption, index: number, view: WholeSongView): HTMLElement {
    const conflicts = wholeSongConflicts(o, view.regions, view.cuts);
    const added = view.regions.find((r) => Math.abs(r.start - o.start) < 0.05 && Math.abs(r.end - o.end) < 0.05 && isWholeSong(r, view.duration));
    const blocked = conflicts.cuts.length > 0;
    const confirming = this.pending === index && !blocked && conflicts.loops.length > 0 && !added;
    if (this.pending === index && !confirming) this.pending = null;

    const use = h('button', {
      class: 'btn sm primary',
      text: added ? 'Added' : 'Use this',
      attrs: {
        type: 'button',
        'data-testid': 'whole-song-use',
        title: added ? 'Already in your loops' : blocked ? 'A cut is inside this option' : 'Add it as a loop with 2 plays',
      },
      on: {
        click: () => {
          if (conflicts.loops.length > 0) {
            this.pending = index;
            this.render();
            this.el.querySelector<HTMLElement>('[data-testid=whole-song-confirm]')?.focus();
          } else this.cb.onUse(index);
        },
      },
    });
    use.disabled = blocked || Boolean(added);

    const actions = h('div', { class: 'whole-actions' });
    if (confirming) {
      actions.append(
        h('span', { class: 'whole-ask small', text: `Replace ${joinList(conflicts.loops.map((l) => `Loop ${l.number}`))}?`, attrs: { role: 'alert' } }),
        h('button', {
          class: 'btn sm primary',
          text: 'Replace',
          attrs: { type: 'button', 'data-testid': 'whole-song-confirm', title: 'Remove those loops and add the whole-song loop' },
          on: {
            click: () => {
              this.pending = null;
              this.cb.onUse(index);
            },
          },
        }),
        h('button', {
          class: 'btn sm quiet',
          text: 'Keep them',
          attrs: { type: 'button', 'data-testid': 'whole-song-cancel' },
          on: {
            click: () => {
              this.pending = null;
              this.render();
              this.el.querySelectorAll<HTMLElement>('[data-testid=whole-song-use]')[index]?.focus();
            },
          },
        }),
      );
    } else {
      actions.append(
        h('button', {
          class: 'btn sm quiet',
          text: 'Audition jump',
          attrs: {
            type: 'button',
            'data-testid': 'whole-song-audition',
            title: 'Hear the last 4 s before the end point, then 4 s from the start point',
          },
          on: { click: () => this.cb.onAudition(index) },
        }),
        use,
      );
    }

    return h(
      'li',
      {
        class: `whole-option${confirming ? ' confirming' : ''}`,
        attrs: { 'data-testid': 'whole-song-option', 'data-index': index },
        on: {
          mouseenter: () => this.cb.onHover(index),
          mouseleave: () => this.cb.onHover(null),
          focusin: () => this.cb.onHover(index),
          focusout: () => this.cb.onHover(null),
        },
      },
      [
        h('div', { class: 'whole-title' }, [
          h('strong', { class: 'whole-name', text: `Option ${index + 1}` }),
          h('span', {
            class: 'stars',
            text: starString(o.stars),
            attrs: { 'aria-label': `${o.stars} of 5 stars`, title: `Score ${(o.score * 100).toFixed(0)}%` },
          }),
          h('span', { class: 'mono times', text: `plays ${formatClock(o.start)} → ${formatClock(o.end)}` }),
          h('span', { class: 'muted small mono whole-keeps', text: `keeps ${Math.round(o.components.coverage * 100)}%` }),
        ]),
        h('div', {
          class: 'small whole-skips',
          text: `skips the first ${formatTime(o.skipsIntro, 1)} and the last ${formatTime(o.skipsOutro, 1)} of each repeat`,
        }),
        h('div', { class: 'small whole-reason', text: o.reason }),
        blocked
          ? h('div', { class: 'small whole-conflict blocked', text: cutBlockText(conflicts.cuts), attrs: { 'data-testid': 'whole-song-conflict', role: 'status' } })
          : conflicts.loops.length > 0 && !added
            ? h('div', { class: 'small whole-conflict', text: replaceText(conflicts.loops), attrs: { 'data-testid': 'whole-song-conflict' } })
            : null,
        actions,
      ],
    );
  }
}
