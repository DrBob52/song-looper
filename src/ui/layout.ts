import { h } from './dom';

/** The window width from which the cards go into two columns (SPEC-v1.3.md 4). */
export const WIDE_QUERY = '(min-width: 1100px)';

export interface CardSet {
  /** The waveform panel: full width in both layouts. */
  wave: HTMLElement;
  suggestions: HTMLElement;
  loops: HTMLElement;
  cuts: HTMLElement;
  ending: HTMLElement;
  length: HTMLElement;
  /** The extended timeline: full width in both layouts. */
  timeline: HTMLElement;
}

/**
 * Lays the song panel's cards out for the window's width.
 *
 * Narrow (below 1100 px): one column, in this order: waveform, suggestions, loops, cuts, ending, length, extended timeline.
 * Wide: the waveform and the extended timeline stay full width, and between them two columns of unequal width (3fr and
 * 2fr): the main column holds Your loops, Cuts and Ending, the side column Suggested loops and Length. Each column is its
 * own stack, so they grow independently and no card is stretched to its neighbour's height.
 *
 * The cards are moved, not copied (and the wide layout is a different parent for them, not a CSS reordering), so the tab
 * order is always the reading order, and nothing that is typed or running in a card is lost.
 */
export class ColumnLayout {
  private mq = window.matchMedia(WIDE_QUERY);
  private columns: HTMLElement;
  private main: HTMLElement;
  private side: HTMLElement;

  constructor(
    private panel: HTMLElement,
    private cards: CardSet,
  ) {
    this.main = h('div', { class: 'col col-main', attrs: { 'data-testid': 'column-main' } });
    this.side = h('div', { class: 'col col-side', attrs: { 'data-testid': 'column-side' } });
    this.columns = h('div', { class: 'columns', attrs: { 'data-testid': 'columns' } }, [this.main, this.side]);
    this.mq.addEventListener('change', () => this.arrange());
    this.arrange();
  }

  get wide(): boolean {
    return this.mq.matches;
  }

  private arrange(): void {
    const c = this.cards;
    if (this.mq.matches) {
      this.main.replaceChildren(c.loops, c.cuts, c.ending);
      this.side.replaceChildren(c.suggestions, c.length);
      this.panel.replaceChildren(c.wave, this.columns, c.timeline);
    } else {
      this.panel.replaceChildren(c.wave, c.suggestions, c.loops, c.cuts, c.ending, c.length, c.timeline);
    }
  }
}
