import { h } from './dom';
import { SKINS } from './skins';
import type { SkinId } from './skins';

/**
 * The "Look" picker in the masthead: one radio button per skin, drawn as a swatch with the skin's name. They are plain
 * radio inputs in one group, so the keyboard works as it does everywhere (Tab into the group, the arrow keys move and
 * choose), and the current look is the checked one, which is marked.
 */
export class SkinPicker {
  readonly el: HTMLElement;
  private inputs = new Map<SkinId, HTMLInputElement>();

  constructor(
    current: SkinId,
    private onChange: (id: SkinId) => void,
  ) {
    const items = SKINS.map((s) => {
      const input = h('input', {
        attrs: { type: 'radio', name: 'look', value: s.id, 'data-testid': `look-${s.id}` },
        on: { change: () => input.checked && this.onChange(s.id) },
      });
      input.checked = s.id === current;
      this.inputs.set(s.id, input);
      const swatch = h('span', { class: 'look-swatch', attrs: { 'aria-hidden': 'true' }, style: { '--sw-a': s.swatch[0], '--sw-b': s.swatch[1], '--sw-c': s.swatch[2] } });
      return h('label', { class: 'look', attrs: { title: s.blurb } }, [
        input,
        swatch,
        // the full name on a wide window, the short one on a narrow one (the hidden one is not read out either)
        h('span', { class: 'look-name' }, [h('span', { class: 'look-full', text: s.name }), h('span', { class: 'look-short', text: s.short })]),
      ]);
    });
    this.el = h('div', { class: 'looks', attrs: { role: 'radiogroup', 'aria-labelledby': 'look-label', 'data-testid': 'look-picker' } }, [
      h('span', { class: 'looks-label', text: 'Look', attrs: { id: 'look-label' } }),
      ...items,
    ]);
  }

  /** Show which look is current (when it was changed from outside the picker). */
  setCurrent(id: SkinId): void {
    for (const [skin, input] of this.inputs) input.checked = skin === id;
  }
}
