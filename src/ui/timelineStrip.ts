import type { Segment } from '../audio/render';
import type { LoopRegion } from '../model';
import { formatTime } from '../util/time';
import { h } from './dom';
import { loopCss, loopInkCss } from './loopColors';

/** Above this many segments the strip draws one block per loop instead of one per play. */
const MAX_BLOCKS = 400;

/**
 * A thin bar showing the extended output: neutral blocks for original audio, coloured blocks for each repeat
 * of a loop. Click to seek the extended preview.
 */
export class TimelineStrip {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private head: HTMLElement;
  private total = 0;

  constructor(private onSeek: (extendedSeconds: number) => void) {
    this.head = h('div', { class: 'tl-head', attrs: { 'aria-hidden': 'true' } });
    this.bar = h('div', {
      class: 'tl-bar',
      attrs: { role: 'slider', tabindex: 0, 'aria-label': 'Extended timeline', 'data-testid': 'timeline' },
      on: {
        click: (e) => {
          const rect = this.bar.getBoundingClientRect();
          if (rect.width <= 0 || this.total <= 0) return;
          const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          this.onSeek(f * this.total);
        },
        keydown: (e) => {
          if (this.total <= 0) return;
          const step = e.shiftKey ? 10 : 2;
          if (e.key === 'ArrowRight') this.nudge(step, e);
          else if (e.key === 'ArrowLeft') this.nudge(-step, e);
        },
      },
    });
    this.el = h('section', { class: 'card', attrs: { 'aria-label': 'Extended timeline' } }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: 'Extended timeline' }),
        h('span', { class: 'muted small', text: 'The run-out groove: click to play the extended cut from there' }),
      ]),
      h('div', { class: 'tl-wrap' }, [this.bar, this.head]),
    ]);
  }

  private pos = 0;
  private nudge(delta: number, e: KeyboardEvent): void {
    e.preventDefault();
    this.onSeek(Math.max(0, Math.min(this.total, this.pos + delta)));
  }

  update(segments: Segment[], regions: LoopRegion[]): void {
    this.bar.replaceChildren();
    this.total = segments.length ? segments[segments.length - 1]!.outEnd : 0;
    if (this.total <= 0) return;
    const byId = new Map(regions.map((r, i) => [r.id, { region: r, index: i }]));
    if (segments.length > MAX_BLOCKS) {
      this.updateRuns(segments, byId);
      return;
    }
    for (const seg of segments) {
      const pct = ((seg.outEnd - seg.outStart) / this.total) * 100;
      const block = h('div', { class: 'tl-block', style: { width: `${pct}%` } });
      if (seg.kind === 'bridge' && seg.regionId) {
        // a bridge: song audio that follows the loop on a repeat, shown hatched in the loop's colour
        const info = byId.get(seg.regionId);
        block.classList.add('bridge');
        block.style.setProperty('--loop-color', info ? loopCss(info.region.color) : 'var(--label-red)');
        block.title = `Loop ${(info?.index ?? 0) + 1} bridge after play ${seg.repeat} (${formatTime(seg.start, 1)} \u2013 ${formatTime(seg.end, 1)})`;
      } else if (seg.kind === 'repeat' && seg.regionId) {
        const info = byId.get(seg.regionId);
        block.classList.add('repeat');
        block.style.background = info ? loopCss(info.region.color) : 'var(--label-red)';
        block.style.color = info ? loopInkCss(info.region.color) : 'var(--on-red)';
        block.style.opacity = (seg.repeat ?? 1) % 2 === 0 ? '0.6' : '1';
        block.title = `Loop ${(info?.index ?? 0) + 1}, play ${seg.repeat} of ${seg.repeats} (${formatTime(seg.outStart, 1)})`;
        if (pct > 4) block.textContent = `${seg.repeat}×`;
      } else {
        block.title = `Original ${formatTime(seg.start, 1)} – ${formatTime(seg.end, 1)}`;
      }
      this.bar.append(block);
    }
  }

  /**
   * A plan with thousands of repeats has too many segments for one element each (9,999 repeats of a loop with a bridge
   * is 20,000): each loop's whole run of repeats and bridges becomes one block, painted as a repeating band, one period
   * per repeat, so the strip still reads like a record's run-out groove.
   */
  private updateRuns(segments: Segment[], byId: Map<string, { region: LoopRegion; index: number }>): void {
    let i = 0;
    while (i < segments.length) {
      const seg = segments[i]!;
      if (seg.kind === 'original' || !seg.regionId) {
        const block = h('div', { class: 'tl-block', style: { width: `${((seg.outEnd - seg.outStart) / this.total) * 100}%` } });
        block.title = `Original ${formatTime(seg.start, 1)} \u2013 ${formatTime(seg.end, 1)}`;
        this.bar.append(block);
        i++;
        continue;
      }
      // the loop's whole run: its repeats and the bridges between them
      let j = i;
      let plays = 0;
      while (j < segments.length && segments[j]!.regionId === seg.regionId && segments[j]!.kind !== 'original') {
        if (segments[j]!.kind === 'repeat') plays++;
        j++;
      }
      const first = seg;
      const last = segments[j - 1]!;
      const run = last.outEnd - first.outStart;
      const loopLen = first.outEnd - first.outStart;
      // one period: the loop, then its bridge (if it has one); the last repeat has no bridge
      const next = segments.slice(i, j).find((s, k) => k > 0 && s.kind === 'repeat');
      const period = next ? next.outStart - first.outStart : loopLen;
      const info = byId.get(seg.regionId);
      const color = info ? loopCss(info.region.color) : 'var(--label-red)';
      const loopPct = Math.min(100, (loopLen / period) * 100);
      const periodPct = (period / run) * 100;
      const block = h('div', { class: 'tl-block repeat run', style: { width: `${(run / this.total) * 100}%` } });
      block.style.setProperty('--loop-color', color);
      block.style.setProperty('--period', `${periodPct}%`);
      block.style.setProperty('--loop-part', `${(loopPct / 100) * periodPct}%`);
      block.dataset.plays = String(plays);
      block.title = `Loop ${(info?.index ?? 0) + 1}, ${plays} plays (${formatTime(first.outStart, 1)} \u2013 ${formatTime(last.outEnd, 1)})`;
      this.bar.append(block);
      i = j;
    }
  }

  /** Move the playhead to an extended-time position. */
  setPosition(extendedSeconds: number): void {
    this.pos = extendedSeconds;
    if (this.total <= 0) {
      this.head.style.display = 'none';
      return;
    }
    this.head.style.display = '';
    this.head.style.left = `${Math.max(0, Math.min(1, extendedSeconds / this.total)) * 100}%`;
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', String(Math.round(this.total)));
    this.bar.setAttribute('aria-valuenow', String(Math.round(extendedSeconds)));
  }
}
