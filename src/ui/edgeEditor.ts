import { formatClock, parseClock, roundMs } from '../util/time';
import { h } from './dom';
import { NumberField } from './numberField';

/** One way of moving a loop's or cut's start or end to an exact time. */
export type EdgeEdit =
  | { type: 'time'; seconds: number }
  /** Add `delta` seconds (a nudge). */
  | { type: 'ms'; delta: number }
  /** One analysed beat earlier or later. */
  | { type: 'beat'; dir: 1 | -1 }
  /** The current playback position of the original song. */
  | { type: 'playhead' };

export type Edge = 'start' | 'end';

export interface EdgeEditorOptions {
  /** The thing the edge belongs to, for the accessible names. */
  noun: 'loop' | 'cut';
  which: Edge;
  /** Id of the time field (label `for`, and the id of its message). */
  fieldId: string;
  /** `data-testid` of the field and of each button. */
  testIds: { field: string; beatDec: string; msDec: string; msInc: string; beatInc: string; playhead: string };
  /** Apply an edit. Returns the reason when it is refused, null when applied. */
  onEdit(edit: EdgeEdit): string | null;
  /** The beat nudges are collected here, so that the panel can hide them when there is no steady beat. */
  beatButtons: HTMLButtonElement[];
}

/**
 * The exact-time controls of one edge, shared by the loop rows and the cut rows:
 *
 *   Start [1:09.600]  [-beat][-10 ms][+10 ms][+beat]  [Set from playhead]
 *
 * Typed values, nudges and the playhead are exact (never snapped); a refused edit shows its message under the field.
 */
export function createEdgeEditor(o: EdgeEditorOptions): { el: HTMLElement; field: NumberField } {
  const label = o.which === 'start' ? 'Start' : 'End';
  const field: NumberField = new NumberField({
    id: o.fieldId,
    label: `${label} time of this ${o.noun}`,
    testId: o.testIds.field,
    value: 0,
    format: (v) => formatClock(v),
    parse: (text) => {
      const v = parseClock(text);
      return v === null ? 'Enter a time like 1:09.600, 1:09 or 69.6.' : roundMs(v);
    },
    step: 0.01,
    width: 10,
    inputMode: 'text',
    onCommit: (seconds) => o.onEdit({ type: 'time', seconds }),
  });
  const apply = (edit: EdgeEdit): void => {
    const refused = o.onEdit(edit);
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
    if (beat) o.beatButtons.push(b);
    return b;
  };
  const el = h('div', { class: 'edge', attrs: { role: 'group', 'aria-label': `${label} of the ${o.noun}` } }, [
    h('label', { class: 'edge-label muted small', text: label, attrs: { for: o.fieldId } }),
    field.el,
    h('span', { class: 'nudges' }, [
      btn('−beat', `${label} one beat earlier`, o.testIds.beatDec, { type: 'beat', dir: -1 }, true),
      btn('−10 ms', `${label} 10 milliseconds earlier`, o.testIds.msDec, { type: 'ms', delta: -0.01 }),
      btn('+10 ms', `${label} 10 milliseconds later`, o.testIds.msInc, { type: 'ms', delta: 0.01 }),
      btn('+beat', `${label} one beat later`, o.testIds.beatInc, { type: 'beat', dir: 1 }, true),
    ]),
    h('button', {
      class: 'btn sm',
      text: 'Set from playhead',
      attrs: { type: 'button', 'data-testid': o.testIds.playhead, title: `Use the playhead as the ${o.which} (${o.which === 'start' ? 'I' : 'O'})` },
      on: {
        click: (e) => {
          e.stopPropagation();
          apply({ type: 'playhead' });
        },
      },
    }),
  ]);
  return { el, field };
}
