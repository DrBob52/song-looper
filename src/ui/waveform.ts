import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import type { Region } from 'wavesurfer.js/plugins/regions';
import type { Cut, LoopRegion, Span } from '../model';
import { cssVar } from './dom';
import { loopResolved } from './loopColors';

export const SELECTION_ID = 'selection';
export const HIGHLIGHT_ID = 'highlight';

export interface WaveformCallbacks {
  onSeek(t: number): void;
  /** The user dragged out or edited the selection. */
  onSelection(sel: Span): void;
  /** A loop region's edges changed (drag finished). */
  onRegionEdit(id: string, start: number, end: number): void;
  /** A cut's edges changed (drag finished). */
  onCutEdit(id: string, start: number, end: number): void;
  onRegionSelect(id: string): void;
  /** Snap function for a region while dragging (null = no snapping). */
  getSnap(id: string): ((t: number) => number) | null;
  /** Allowed [lo, hi] range for a loop region so it cannot overlap its neighbours. */
  getBounds(id: string): Span | null;
  /** Minimum region length in seconds (one bar or beat when snapping; `free` when Shift is held and snapping is off). */
  getMinLength(id: string, free?: boolean): number;
}

export interface GridData {
  beats: number[];
  /** Times of bar lines (subset of beats). */
  bars: number[];
}

export interface SectionMarker {
  start: number;
  label: string;
  hint?: string;
}

interface DragTrack {
  lastStart: number;
  lastEnd: number;
  rawStart: number;
  rawEnd: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** wavesurfer.js waveform plus regions, grid overlay and section markers. */
export class WaveformView {
  private ws: WaveSurfer;
  private regions: RegionsPlugin;
  private duration: number;
  private tracks = new Map<string, DragTrack>();
  private shiftDown = false;
  /** Id of the region whose edge or body is being dragged right now, if any. */
  private dragging: string | null = null;
  private disposers: (() => void)[] = [];
  private overlay: HTMLDivElement | null = null;
  private beatGroup: SVGGElement | null = null;
  private barGroup: SVGGElement | null = null;
  private beatPeriod = 0.5;
  private barPeriod = 2;
  private model = new Map<string, LoopRegion>();
  private cutModel = new Map<string, Cut>();
  private contentText = new Map<string, string>();
  private followCursor = true;
  private selectedId: string | null = null;
  /** A selection the app asked for (I and O keys): its region is created as given, not snapped like a drag. */
  private pendingSelection: Span | null = null;

  constructor(
    container: HTMLElement,
    peaks: Float32Array,
    duration: number,
    private cb: WaveformCallbacks,
  ) {
    this.duration = duration;
    this.regions = RegionsPlugin.create();
    this.ws = WaveSurfer.create({
      container,
      height: 150,
      waveColor: cssVar('--ink') || '#1d1915',
      progressColor: cssVar('--ink') || '#1d1915',
      cursorColor: cssVar('--label-red') || '#c6372c',
      cursorWidth: 2,
      normalize: true,
      interact: true,
      autoScroll: true,
      autoCenter: false,
      minPxPerSec: 0,
      peaks: [peaks],
      duration,
      plugins: [this.regions],
    });

    this.ws.on('interaction', (t) => this.cb.onSeek(t));
    this.ws.on('redraw', () => this.updateGridVisibility());
    this.ws.on('zoom', () => this.updateGridVisibility());
    this.ws.on('resize', () => this.updateGridVisibility());

    this.regions.on('region-update', (region, side) => this.onRegionUpdate(region, side));
    this.regions.on('region-updated', (region) => this.onRegionUpdated(region));
    this.regions.on('region-clicked', (region) => {
      if (this.model.has(region.id) || this.cutModel.has(region.id)) this.cb.onRegionSelect(region.id);
    });
    this.regions.on('region-created', (region) => this.onRegionCreated(region));

    // Drag on empty waveform space to make a selection.
    const stopDragSelection = this.regions.enableDragSelection(
      { id: SELECTION_ID, color: hexToRgba(cssVar('--mustard') || '#d6a03d', 0.3), drag: true, resize: true },
      4,
    );
    this.disposers.push(stopDragSelection);

    const onKey = (e: KeyboardEvent): void => {
      this.shiftDown = e.shiftKey;
    };
    const onPointer = (e: PointerEvent): void => {
      this.shiftDown = e.shiftKey;
    };
    // Fallback in case a drag ends without a 'region-updated' event.
    const onPointerUp = (): void => {
      window.setTimeout(() => (this.dragging = null), 0);
    };
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    this.disposers.push(() => {
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
    });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('pointermove', onPointer, true);
    window.addEventListener('pointerdown', onPointer, true);
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('pointerdown', onPointer, true);
    });

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = (): void => this.refreshTheme();
    mq.addEventListener('change', onScheme);
    this.disposers.push(() => mq.removeEventListener('change', onScheme));
    // A host page (claude.ai) can switch theme via data-theme on <html>.
    const themeObserver = new MutationObserver(onScheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.disposers.push(() => themeObserver.disconnect());
  }

  /** Re-read theme colours after a light/dark switch. */
  refreshTheme(): void {
    const ink = cssVar('--ink') || '#1d1915';
    this.ws.setOptions({ waveColor: ink, progressColor: ink, cursorColor: cssVar('--label-red') || '#c6372c' });
    // loop colours, the selection and the highlight follow the theme too
    this.setRegions([...this.model.values()], this.selectedId, [...this.cutModel.values()]);
    const selection = this.findRegion(SELECTION_ID);
    selection?.setOptions({ color: hexToRgba(cssVar('--mustard') || '#d6a03d', 0.3) });
    const highlight = this.findRegion(HIGHLIGHT_ID);
    highlight?.setOptions({ color: hexToRgba(cssVar('--mustard') || '#d6a03d', 0.34) });
  }

  getWrapper(): HTMLElement {
    return this.ws.getWrapper();
  }

  /** The wavesurfer instance, for tests and advanced use. */
  get instance(): WaveSurfer {
    return this.ws;
  }

  setZoom(pxPerSec: number): void {
    // 0 means "fit to width".
    try {
      this.ws.zoom(pxPerSec);
    } catch {
      /* not ready yet */
    }
  }

  /** Move the playhead. While `playing`, the view scrolls to keep it visible. */
  setCursor(t: number, playing: boolean): void {
    if (this.duration <= 0) return;
    const progress = Math.max(0, Math.min(1, t / this.duration));
    this.ws.getRenderer().renderProgress(progress, playing && this.followCursor);
  }

  setFollowCursor(on: boolean): void {
    this.followCursor = on;
  }

  // ---- grid and sections -------------------------------------------------------

  private ensureOverlay(): HTMLDivElement {
    if (this.overlay) return this.overlay;
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden;';
    this.ws.getWrapper().appendChild(overlay);
    this.overlay = overlay;
    return overlay;
  }

  setGrid(grid: GridData | null, sections: SectionMarker[] = []): void {
    const overlay = this.ensureOverlay();
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    this.beatGroup = null;
    this.barGroup = null;

    if (grid && grid.beats.length > 1) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${this.duration} 1`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
      const mk = (times: number[], stroke: string, width: string): SVGGElement => {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('stroke', stroke);
        g.setAttribute('stroke-width', width);
        g.setAttribute('vector-effect', 'non-scaling-stroke');
        for (const t of times) {
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('x1', String(t));
          line.setAttribute('x2', String(t));
          line.setAttribute('y1', '0');
          line.setAttribute('y2', '1');
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          g.appendChild(line);
        }
        return g;
      };
      const barSet = new Set(grid.bars);
      const plainBeats = grid.beats.filter((t) => !barSet.has(t));
      this.beatGroup = mk(plainBeats, 'var(--grid, rgba(128,128,128,.25))', '1');
      this.barGroup = mk(grid.bars, 'var(--grid-bar, rgba(128,128,128,.55))', '1');
      svg.appendChild(this.beatGroup);
      svg.appendChild(this.barGroup);
      overlay.appendChild(svg);
      this.beatPeriod = (grid.beats[grid.beats.length - 1]! - grid.beats[0]!) / (grid.beats.length - 1);
      this.barPeriod =
        grid.bars.length > 1
          ? (grid.bars[grid.bars.length - 1]! - grid.bars[0]!) / (grid.bars.length - 1)
          : this.beatPeriod * 4;
    }

    for (const s of sections) {
      const line = document.createElement('div');
      line.style.cssText = `position:absolute;top:0;bottom:0;width:0;left:${(s.start / this.duration) * 100}%;border-left:1px solid var(--mustard, #d6a03d);`;
      // a small mustard sticker with the section's letter
      const tag = document.createElement('div');
      tag.textContent = s.label;
      tag.title = s.hint ? `Section ${s.label} (${s.hint})` : `Section ${s.label}`;
      tag.style.cssText =
        'position:absolute;bottom:4px;left:3px;min-width:17px;height:17px;display:grid;place-items:center;font:700 10px/1 var(--font-mono, monospace);padding:0 3px;border-radius:9px;background:var(--mustard, #d6a03d);color:#1d1915;box-shadow:0 1px 1px rgba(0,0,0,.3);';
      line.appendChild(tag);
      overlay.appendChild(line);
    }
    this.updateGridVisibility();
  }

  private updateGridVisibility(): void {
    const w = this.ws.getWrapper().clientWidth;
    if (!w || !this.duration) return;
    const pxPerSec = w / this.duration;
    if (this.beatGroup) this.beatGroup.style.display = pxPerSec * this.beatPeriod >= 7 ? '' : 'none';
    if (this.barGroup) this.barGroup.style.display = pxPerSec * this.barPeriod >= 4 ? '' : 'none';
  }

  // ---- regions -----------------------------------------------------------------

  private findRegion(id: string): Region | undefined {
    return this.regions.getRegions().find((r) => r.id === id);
  }

  /** Reconcile wavesurfer regions with the loop model and the cuts (`selectedId` may name either). */
  setRegions(loops: LoopRegion[], selectedId: string | null, cuts: Cut[] = []): void {
    this.model = new Map(loops.map((l) => [l.id, l]));
    this.cutModel = new Map(cuts.map((c) => [c.id, c]));
    this.selectedId = selectedId;
    const wanted = new Set([...loops.map((l) => l.id), ...cuts.map((c) => c.id)]);
    for (const r of [...this.regions.getRegions()]) {
      if (r.id === SELECTION_ID || r.id === HIGHLIGHT_ID) continue;
      if (!wanted.has(r.id)) {
        r.remove();
        this.tracks.delete(r.id);
        this.contentText.delete(r.id);
      }
    }
    loops.forEach((loop, index) => {
      const selected = loop.id === selectedId;
      const solid = loopResolved(loop.color);
      const color = hexToRgba(solid, Number(cssVar(selected ? '--region-alpha-on' : '--region-alpha')) || (selected ? 0.42 : 0.28));
      let r = this.findRegion(loop.id);
      if (!r) {
        r = this.regions.addRegion({
          id: loop.id,
          start: loop.start,
          end: loop.end,
          color,
          drag: true,
          resize: true,
        });
      } else if (loop.id === this.dragging) {
        // Mid-drag: the user's hand wins. The model catches up when the drag ends.
        r.setOptions({ color });
      } else {
        r.setOptions({ start: loop.start, end: loop.end, color });
      }
      const text = `${index + 1}${loop.repeats > 1 ? ` ×${loop.repeats}` : ''}`;
      if (this.contentText.get(loop.id) !== text) {
        this.contentText.set(loop.id, text);
        r.setContent(text);
      }
      if (r.element) {
        // translucent loop colour with a 2 px band of the solid colour along the top
        r.element.style.borderTop = `2px solid ${solid}`;
        r.element.style.outline = selected ? `2px solid ${solid}` : 'none';
        r.element.style.outlineOffset = '-2px';
        r.element.dataset.regionId = loop.id;
      }
      if (loop.id !== this.dragging) {
        this.tracks.set(loop.id, { lastStart: loop.start, lastEnd: loop.end, rawStart: loop.start, rawEnd: loop.end });
      }
    });
    // cuts: dark hatched regions with a scissors label; dragged and resized like loops
    cuts.forEach((cut, index) => {
      const selected = cut.id === selectedId;
      const color = cssVar('--cut-fill') || 'rgba(29, 25, 21, 0.55)';
      let r = this.findRegion(cut.id);
      if (!r) {
        r = this.regions.addRegion({ id: cut.id, start: cut.start, end: cut.end, color, drag: true, resize: true });
      } else if (cut.id === this.dragging) {
        r.setOptions({ color });
      } else {
        r.setOptions({ start: cut.start, end: cut.end, color });
      }
      const text = `\u2702 ${index + 1}`;
      if (this.contentText.get(cut.id) !== text) {
        this.contentText.set(cut.id, text);
        const label = document.createElement('span');
        label.textContent = text;
        label.style.cssText = 'color:var(--cut-ink,#fff);font-weight:700;padding:1px 3px;border-radius:2px;background:var(--cut-label-bg,rgba(0,0,0,.5));';
        r.setContent(label);
      }
      if (r.element) {
        // hatching over the dark fill, a 2 px top band in the cut's line colour, an outline when selected
        r.element.style.backgroundImage = 'repeating-linear-gradient(135deg, var(--cut-line, rgba(255,255,255,.4)) 0 2px, transparent 2px 7px)';
        r.element.style.borderTop = '2px solid var(--cut-line, #fff)';
        r.element.style.outline = selected ? '2px solid var(--cut-line, #fff)' : 'none';
        r.element.style.outlineOffset = '-2px';
        r.element.dataset.regionId = cut.id;
        r.element.dataset.kind = 'cut';
      }
      if (cut.id !== this.dragging) {
        this.tracks.set(cut.id, { lastStart: cut.start, lastEnd: cut.end, rawStart: cut.start, rawEnd: cut.end });
      }
    });
  }

  /** The draggable selection (what `L` turns into a loop). */
  setSelection(sel: Span | null): void {
    const existing = this.findRegion(SELECTION_ID);
    if (!sel) {
      existing?.remove();
      this.tracks.delete(SELECTION_ID);
      return;
    }
    if (existing) existing.setOptions({ start: sel.start, end: sel.end });
    else {
      this.pendingSelection = sel;
      this.regions.addRegion({
        id: SELECTION_ID,
        start: sel.start,
        end: sel.end,
        color: hexToRgba(cssVar('--mustard') || '#d6a03d', 0.3),
        drag: true,
        resize: true,
      });
    }
    this.tracks.set(SELECTION_ID, { lastStart: sel.start, lastEnd: sel.end, rawStart: sel.start, rawEnd: sel.end });
    const r = this.findRegion(SELECTION_ID);
    if (r?.element) {
      r.element.style.border = '1.5px dashed var(--ink, #1d1915)';
      r.element.dataset.regionId = SELECTION_ID;
    }
  }

  /** A non-interactive highlight (hovering a suggestion, previewing a span). */
  setHighlight(span: Span | null): void {
    const existing = this.findRegion(HIGHLIGHT_ID);
    if (!span) {
      existing?.remove();
      return;
    }
    if (existing) existing.setOptions({ start: span.start, end: span.end });
    else {
      const r = this.regions.addRegion({
        id: HIGHLIGHT_ID,
        start: span.start,
        end: span.end,
        color: hexToRgba(cssVar('--mustard') || '#d6a03d', 0.34),
        drag: false,
        resize: false,
      });
      if (r.element) {
        r.element.style.pointerEvents = 'none';
        r.element.style.boxShadow = 'inset 0 0 0 2px var(--mustard, #d6a03d)';
        r.element.dataset.regionId = HIGHLIGHT_ID;
      }
    }
  }

  // ---- drag handling -----------------------------------------------------------

  private onRegionCreated(region: Region): void {
    if (region.id !== SELECTION_ID) return;
    const asked = this.pendingSelection;
    if (asked && Math.abs(region.start - asked.start) < 1e-9 && Math.abs(region.end - asked.end) < 1e-9) {
      // made by setSelection from the model: exactly as asked, nothing to report back
      this.pendingSelection = null;
      return;
    }
    // Drag-created: there must be only one selection. Drop any earlier one.
    for (const other of this.regions.getRegions()) {
      if (other.id === SELECTION_ID && other !== region) other.remove();
    }
    const snap = this.shiftDown ? null : this.cb.getSnap(SELECTION_ID);
    let start = region.start;
    let end = region.end;
    if (snap) {
      start = snap(start);
      end = snap(end);
      const minLen = this.cb.getMinLength(SELECTION_ID);
      if (end - start < minLen) end = start + minLen;
    }
    region.setOptions({ start, end });
    if (region.element) {
      region.element.style.border = '1.5px dashed var(--ink, #1d1915)';
      region.element.dataset.regionId = SELECTION_ID;
    }
    this.tracks.set(SELECTION_ID, { lastStart: start, lastEnd: end, rawStart: start, rawEnd: end });
    this.cb.onSelection({ start, end });
  }

  /** Live snapping and overlap clamping while a region is being dragged or resized. */
  private onRegionUpdate(region: Region, side?: 'start' | 'end'): void {
    if (region.id === HIGHLIGHT_ID) return;
    this.dragging = region.id;
    const track =
      this.tracks.get(region.id) ??
      ({ lastStart: region.start, lastEnd: region.end, rawStart: region.start, rawEnd: region.end } as DragTrack);
    this.tracks.set(region.id, track);

    // The plugin adds the mouse delta to the (already snapped) value, so the change since
    // our last write is the raw delta. Accumulate it so small moves are not swallowed by snapping.
    track.rawStart += region.start - track.lastStart;
    track.rawEnd += region.end - track.lastEnd;

    const snap = this.shiftDown ? null : this.cb.getSnap(region.id);
    const minLen = this.cb.getMinLength(region.id, this.shiftDown);
    const bounds = this.cb.getBounds(region.id);
    let start = track.rawStart;
    let end = track.rawEnd;
    const length = track.lastEnd - track.lastStart;

    if (side === 'start') {
      if (snap) start = snap(start);
      if (bounds) start = Math.max(bounds.start, start);
      start = Math.min(start, track.lastEnd - minLen);
      end = track.lastEnd;
    } else if (side === 'end') {
      if (snap) end = snap(end);
      if (bounds) end = Math.min(bounds.end, end);
      end = Math.max(end, track.lastStart + minLen);
      start = track.lastStart;
    } else {
      // Whole-region move: keep the length, snap the start.
      if (snap) start = snap(start);
      end = start + length;
      if (bounds) {
        if (start < bounds.start) {
          start = bounds.start;
          end = start + length;
        }
        if (end > bounds.end) {
          end = bounds.end;
          start = end - length;
        }
      }
      if (start < 0) {
        start = 0;
        end = length;
      }
      if (end > this.duration) {
        end = this.duration;
        start = end - length;
      }
    }

    if (start !== region.start || end !== region.end) region.setOptions({ start, end });
    track.lastStart = start;
    track.lastEnd = end;
  }

  private onRegionUpdated(region: Region): void {
    this.dragging = null;
    const track = this.tracks.get(region.id);
    if (track) {
      track.rawStart = region.start;
      track.rawEnd = region.end;
      track.lastStart = region.start;
      track.lastEnd = region.end;
    }
    if (region.id === SELECTION_ID) this.cb.onSelection({ start: region.start, end: region.end });
    else if (this.model.has(region.id)) this.cb.onRegionEdit(region.id, region.start, region.end);
    else if (this.cutModel.has(region.id)) this.cb.onCutEdit(region.id, region.start, region.end);
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.ws.destroy();
  }
}
