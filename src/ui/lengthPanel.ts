import { formatTime } from '../util/time';
import { h } from './dom';

/** Original -> extended length readout. (Target-length mode is added in milestone 6.) */
export class LengthPanel {
  readonly el: HTMLElement;
  private original: HTMLElement;
  private extended: HTMLElement;
  private note: HTMLElement;

  constructor() {
    this.original = h('span', { class: 'mono big', attrs: { 'data-testid': 'length-original' } });
    this.extended = h('span', { class: 'mono big', attrs: { 'data-testid': 'length-extended' } });
    this.note = h('div', { class: 'muted small', attrs: { 'data-testid': 'length-note' } });
    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Length' } }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Length' })]),
      h('div', { class: 'row' }, [this.original, h('span', { class: 'muted', text: '→' }), this.extended]),
      this.note,
    ]);
  }

  update(originalSeconds: number, extendedSeconds: number, note = ''): void {
    this.original.textContent = formatTime(originalSeconds);
    this.extended.textContent = formatTime(extendedSeconds);
    this.note.textContent = note;
  }
}
