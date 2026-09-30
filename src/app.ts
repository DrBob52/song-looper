import { RENDER_CONFIG } from './audio/config';
import { computePeaks, decodeFile } from './audio/decode';
import type { DecodedSong } from './audio/decode';
import { Player } from './audio/player';
import { renderLoopBody, renderSeamSnippet } from './audio/preview';
import {
  buildTimeline,
  extendedDuration,
  extendedToOriginal,
  originalToExtended,
  planKey,
} from './audio/render';
import { RenderClient, SupersededError } from './audio/renderClient';
import { downloadBlob, estimateWavSize } from './audio/wav';
import type { LoopRegion, Plan, Span } from './model';
import { MAX_EXTENDED_SECONDS } from './model';
import { MIN_REGION_SECONDS, fitSpan, neighbourBounds, newRegionId, nextColor, sortRegions } from './plan';
import { Dropzone } from './ui/dropzone';
import { h } from './ui/dom';
import { ExportDialog } from './ui/exportDialog';
import { LengthPanel } from './ui/lengthPanel';
import { RegionsPanel } from './ui/regionsPanel';
import { Transport } from './ui/transport';
import type { PlayMode } from './ui/transport';
import { SELECTION_ID, WaveformView } from './ui/waveform';
import { createStore } from './util/store';

export interface AppState {
  song: DecodedSong | null;
  regions: LoopRegion[];
  selectedId: string | null;
  selection: Span | null;
  playMode: PlayMode;
  zoom: number;
  /** Seam crossfade length in ms. */
  seamMs: number;
  notice: string | null;
  /** Loop currently being previewed (Loop button), if any. */
  previewingId: string | null;
  renderState: 'idle' | 'rendering' | 'ready' | 'error';
}

type AuxInfo =
  | { kind: 'loop'; originalStart: number; period: number }
  | { kind: 'seam'; region: Span; seamTime: number };

export class App {
  readonly store = createStore<AppState>({
    song: null,
    regions: [],
    selectedId: null,
    selection: null,
    playMode: 'original',
    zoom: 0,
    seamMs: RENDER_CONFIG.crossfadeMs,
    notice: null,
    previewingId: null,
    renderState: 'idle',
  });
  readonly player = new Player();
  private renderClient = new RenderClient();
  private dropzone: Dropzone;
  private transport: Transport;
  private regionsPanel: RegionsPanel;
  private lengthPanel: LengthPanel;
  private exportDialog: ExportDialog;
  private songPanel: HTMLElement;
  private waveHost: HTMLElement;
  private noticeEl: HTMLElement;
  private waveform: WaveformView | null = null;
  private raf = 0;
  private loadToken = 0;
  private noticeTimer = 0;
  private renderTimer = 0;
  private extendedKey: string | null = null;
  private timeline = buildTimeline({ regions: [] }, 0);
  private aux: AuxInfo | null = null;

  constructor(private root: HTMLElement) {
    this.dropzone = new Dropzone((f) => void this.loadFile(f));
    this.transport = new Transport({
      onTogglePlay: () => void this.togglePlay(),
      onMode: (m) => void this.setPlayMode(m),
      onExport: () => this.openExport(),
    });
    this.transport.setEnabled(false);
    this.regionsPanel = new RegionsPanel({
      onAdd: () => this.addLoop(),
      onSelect: (id) => this.selectRegion(id),
      onRepeats: (id, n) => this.setRepeats(id, n),
      onSnapToggle: (id, v) => this.updateRegion(id, { snapToBars: v }),
      onPreviewLoop: (id) => void this.previewLoop(id),
      onAuditionSeam: (id) => void this.auditionSeam(id),
      onRemove: (id) => this.removeRegion(id),
      onHover: (id) => {
        const r = id ? this.store.get().regions.find((x) => x.id === id) : undefined;
        this.waveform?.setHighlight(r ? { start: r.start, end: r.end } : null);
      },
    });
    this.lengthPanel = new LengthPanel();
    this.exportDialog = new ExportDialog({ onExport: (o) => this.doExport(o), onCancel: () => undefined });
    this.waveHost = h('div', { class: 'wave-host', attrs: { 'data-testid': 'waveform' } });
    this.noticeEl = h('div', { class: 'notice', attrs: { role: 'status', 'data-testid': 'notice' } });

    const zoom = h('input', {
      attrs: { type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Zoom', 'data-testid': 'zoom' },
      on: { input: (e) => this.setZoom(Number((e.target as HTMLInputElement).value)) },
    });
    const toolbar = h('div', { class: 'wave-toolbar' }, [
      h('label', { class: 'field grow' }, [h('span', { text: 'Zoom' }), zoom]),
    ]);
    this.songPanel = h(
      'div',
      { attrs: { hidden: true, 'data-testid': 'song-panel' }, style: { display: 'grid', gap: '14px' } },
      [
        h('section', { class: 'card', attrs: { 'aria-label': 'Waveform' } }, [
          toolbar,
          this.waveHost,
          h('div', { class: 'wave-hint' }, [
            'Click to seek. Drag on the waveform to select a span, then press ',
            h('kbd', { text: 'L' }),
            ' to add a loop. ',
            h('kbd', { text: 'Space' }),
            ' play/pause, ',
            h('kbd', { text: 'Delete' }),
            ' removes the selected loop.',
          ]),
          this.noticeEl,
        ]),
        this.regionsPanel.el,
        this.lengthPanel.el,
      ],
    );

    this.root.append(
      h('div', { class: 'app' }, [
        h('header', { class: 'top' }, [
          h('h1', { text: 'Song Looper' }),
          h('p', { text: 'Drop a song, find sections that loop cleanly, repeat them, and export an extended WAV.' }),
        ]),
        this.dropzone.el,
        this.songPanel,
        this.transport.el,
      ]),
      this.exportDialog.el,
    );

    this.player.subscribe(() => {
      this.transport.setPlaying(this.player.isPlaying() || this.player.isAuxPlaying());
      this.startTicker();
      this.renderTime();
    });
    this.store.subscribe((s, prev) => this.onState(s, prev));
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ---- state -> views ----------------------------------------------------------

  private plan(): Plan {
    return { regions: this.store.get().regions };
  }

  private onState(s: AppState, prev: AppState): void {
    const regionsChanged = s.regions !== prev.regions;
    if (regionsChanged || s.selectedId !== prev.selectedId || s.song !== prev.song) {
      this.waveform?.setRegions(s.regions, s.selectedId);
    }
    if (regionsChanged || s.selectedId !== prev.selectedId || s.previewingId !== prev.previewingId || s.song !== prev.song) {
      this.regionsPanel.update(s.regions, s.selectedId, {
        barsOf: () => null,
        hasGrid: false,
        previewingId: s.previewingId,
      });
    }
    if (s.selection !== prev.selection) this.waveform?.setSelection(s.selection);
    if (s.playMode !== prev.playMode) this.transport.setMode(s.playMode);
    if (s.notice !== prev.notice) this.noticeEl.textContent = s.notice ?? '';
    if (s.renderState !== prev.renderState) {
      this.transport.setStatus(s.renderState === 'rendering' ? 'Rendering…' : s.renderState === 'error' ? 'Render failed' : '');
    }
    if (regionsChanged || s.song !== prev.song || s.seamMs !== prev.seamMs) {
      if (s.song) this.timeline = buildTimeline(this.plan(), s.song.duration);
      this.updateLength();
      this.onPlanChanged(regionsChanged || s.seamMs !== prev.seamMs);
    }
  }

  private updateLength(): void {
    const { song } = this.store.get();
    if (!song) return;
    const ext = extendedDuration(this.plan(), song.duration);
    let note = '';
    if (ext > MAX_EXTENDED_SECONDS) note = `Too long: the limit is ${MAX_EXTENDED_SECONDS / 60} minutes. Lower a repeat count.`;
    else if (ext > 20 * 60) note = 'That is a long file. Rendering may be slow.';
    this.lengthPanel.update(song.duration, ext, note);
  }

  private onPlanChanged(contentChanged: boolean): void {
    if (!contentChanged) return;
    this.extendedKey = null;
    if (this.player.isAuxPlaying()) this.stopAux();
    if (this.store.get().playMode === 'extended') this.scheduleRender();
  }

  // ---- notices -----------------------------------------------------------------

  notify(message: string): void {
    this.store.set({ notice: message });
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.store.set({ notice: null }), 6000);
  }

  // ---- keyboard ----------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    const typing =
      (tag === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox' && (t as HTMLInputElement).type !== 'range') ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      t?.isContentEditable === true;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.exportDialog.el.open) return;
    if (e.code === 'Space' && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      void this.togglePlay();
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      this.addLoop();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const { selectedId, selection } = this.store.get();
      if (selectedId) {
        e.preventDefault();
        this.removeRegion(selectedId);
      } else if (selection) {
        e.preventDefault();
        this.store.set({ selection: null });
      }
    } else if (e.key === 'Escape') {
      if (this.player.isAuxPlaying()) this.stopAux();
      this.store.set({ selection: null, selectedId: null });
    }
  }

  // ---- loading -----------------------------------------------------------------

  async loadFile(file: File): Promise<void> {
    const token = ++this.loadToken;
    this.stopEverything();
    this.dropzone.showError(null);
    this.dropzone.setBusy(true);
    this.dropzone.showProgress('Decoding audio…', null);
    try {
      const song = await decodeFile(file);
      if (token !== this.loadToken) return;
      this.openSong(song);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.dropzone.showError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === this.loadToken) {
        this.dropzone.setBusy(false);
        this.dropzone.hideProgress();
      }
    }
  }

  private stopEverything(): void {
    window.clearTimeout(this.renderTimer);
    this.player.stop();
    this.stopAux();
  }

  private openSong(song: DecodedSong): void {
    this.waveform?.destroy();
    this.waveform = null;
    this.extendedKey = null;
    this.renderClient.setSource(song.buffer);
    this.player.setBuffer(song.buffer);
    this.timeline = buildTimeline({ regions: [] }, song.duration);
    this.store.set({
      song,
      regions: [],
      selectedId: null,
      selection: null,
      playMode: 'original',
      previewingId: null,
      renderState: 'idle',
      notice: null,
    });
    this.dropzone.showFile(song);
    this.songPanel.hidden = false;
    this.transport.setEnabled(true);

    const peaks = computePeaks(song.buffer, 100);
    this.waveform = new WaveformView(this.waveHost, peaks, song.duration, {
      onSeek: (t) => this.seekOriginal(t),
      onSelection: (sel) => this.store.set({ selection: sel }),
      onRegionEdit: (id, start, end) => this.updateRegion(id, { start, end }),
      onRegionSelect: (id) => this.selectRegion(id),
      getSnap: () => null,
      getBounds: (id) => {
        const s = this.store.get();
        return id === SELECTION_ID || !s.song ? null : neighbourBounds(s.regions, id, s.song.duration);
      },
      getMinLength: () => MIN_REGION_SECONDS,
    });
    this.waveform.setZoom(this.store.get().zoom);
    this.waveform.setRegions([], null);
    this.renderTime();
  }

  // ---- regions -----------------------------------------------------------------

  private playheadOriginalTime(): number {
    const t = this.player.getTime();
    return this.store.get().playMode === 'extended' ? extendedToOriginal(this.timeline, t).time : t;
  }

  addLoop(span?: Span, extra: Partial<LoopRegion> = {}): string | null {
    const { song, regions, selection } = this.store.get();
    if (!song) return null;
    let want = span ?? selection;
    if (!want) {
      const at = this.playheadOriginalTime();
      want = { start: at, end: Math.min(song.duration, at + Math.min(8, song.duration / 4)) };
    }
    const fit = fitSpan(regions, want, song.duration, MIN_REGION_SECONDS);
    if (!fit) {
      this.notify('That span overlaps an existing loop or is too short. Select a free span and try again.');
      return null;
    }
    const id = newRegionId();
    const region: LoopRegion = {
      id,
      start: fit.start,
      end: fit.end,
      repeats: 2,
      color: nextColor(regions),
      snapToBars: true,
      ...extra,
    };
    this.store.set({ regions: sortRegions([...regions, region]), selectedId: id, selection: null });
    return id;
  }

  private updateRegion(id: string, patch: Partial<LoopRegion>): void {
    const { song, regions } = this.store.get();
    if (!song) return;
    const current = regions.find((r) => r.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (patch.start !== undefined || patch.end !== undefined) {
      const fit = fitSpan(regions, { start: next.start, end: next.end }, song.duration, MIN_REGION_SECONDS, id);
      if (!fit) {
        // Refuse: snap the view back to the model.
        this.store.set({ regions: [...regions] });
        this.notify('Loops cannot overlap. The edit was refused.');
        return;
      }
      next.start = fit.start;
      next.end = fit.end;
    }
    this.store.set({ regions: sortRegions(regions.map((r) => (r.id === id ? next : r))) });
  }

  private setRepeats(id: string, repeats: number): void {
    this.updateRegion(id, { repeats });
  }

  private selectRegion(id: string): void {
    if (this.store.get().selectedId !== id) this.store.set({ selectedId: id });
  }

  removeRegion(id: string): void {
    const { regions, selectedId, previewingId } = this.store.get();
    if (previewingId === id) this.stopAux();
    this.store.set({
      regions: regions.filter((r) => r.id !== id),
      selectedId: selectedId === id ? null : selectedId,
    });
  }

  // ---- zoom --------------------------------------------------------------------

  private setZoom(v: number): void {
    // Slider 0 = fit; otherwise log scale 10..400 px per second.
    const px = v <= 0 ? 0 : Math.round(10 * Math.pow(40, v / 100));
    this.store.set({ zoom: px });
    this.waveform?.setZoom(px);
  }

  // ---- playback ----------------------------------------------------------------

  async togglePlay(): Promise<void> {
    const { song, playMode } = this.store.get();
    if (!song) return;
    if (this.player.isAuxPlaying()) {
      this.stopAux();
      return;
    }
    if (this.player.isPlaying()) {
      this.player.pause();
      return;
    }
    if (playMode === 'extended' && this.extendedKey === null) {
      const ok = await this.renderExtendedPreview();
      if (!ok) return;
    }
    await this.player.play();
  }

  private seekOriginal(t: number): void {
    if (this.player.isAuxPlaying()) this.stopAux();
    const { playMode } = this.store.get();
    this.player.seek(playMode === 'extended' ? originalToExtended(this.timeline, t) : t);
    this.renderTime();
  }

  async setPlayMode(mode: PlayMode): Promise<void> {
    const { song, playMode } = this.store.get();
    if (!song || mode === playMode) return;
    this.stopAux();
    const wasPlaying = this.player.isPlaying();
    const t = this.player.getTime();
    this.player.pause();
    if (mode === 'original') {
      const orig = extendedToOriginal(this.timeline, t).time;
      window.clearTimeout(this.renderTimer);
      this.store.set({ playMode: 'original' });
      this.player.setBuffer(song.buffer);
      this.player.seek(orig);
      if (wasPlaying) await this.player.play();
    } else {
      const origT = t;
      this.store.set({ playMode: 'extended' });
      const ok = await this.renderExtendedPreview();
      if (!ok) return;
      this.player.seek(originalToExtended(this.timeline, origT));
      if (wasPlaying) await this.player.play();
    }
    this.renderTime();
  }

  private scheduleRender(): void {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => void this.renderExtendedPreview(), RENDER_CONFIG.renderDebounceMs);
  }

  /** Render the extended song in the worker and load it into the player. */
  private async renderExtendedPreview(): Promise<boolean> {
    const { song, seamMs } = this.store.get();
    if (!song) return false;
    const plan = this.plan();
    const key = planKey(plan, song.duration, seamMs);
    if (this.extendedKey === key) return true;
    if (extendedDuration(plan, song.duration) > MAX_EXTENDED_SECONDS) {
      this.store.set({ renderState: 'error' });
      this.notify(`The extended song is longer than ${MAX_EXTENDED_SECONDS / 60} minutes. Lower a repeat count.`);
      return false;
    }
    this.store.set({ renderState: 'rendering' });
    try {
      const { channels, sampleRate } = await this.renderClient.render(plan, seamMs);
      if (this.store.get().playMode !== 'extended') {
        this.store.set({ renderState: 'idle' });
        return false;
      }
      const wasPlaying = this.player.isPlaying();
      this.player.setChannels(channels, sampleRate, true);
      if (wasPlaying && !this.player.isPlaying()) await this.player.play(undefined);
      this.extendedKey = key;
      this.timeline = buildTimeline(plan, song.duration);
      this.store.set({ renderState: 'ready' });
      return true;
    } catch (err) {
      if (err instanceof SupersededError) return false;
      this.store.set({ renderState: 'error' });
      this.notify(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  // ---- previews (aux playback) -------------------------------------------------

  private stopAux(): void {
    if (this.store.get().previewingId !== null) this.store.set({ previewingId: null });
    this.aux = null;
    this.player.stopAux();
  }

  async previewLoop(id: string): Promise<void> {
    const { song, regions, seamMs, previewingId } = this.store.get();
    if (!song) return;
    if (previewingId === id) {
      this.stopAux();
      return;
    }
    const region = regions.find((r) => r.id === id);
    if (!region) return;
    this.stopAux();
    this.player.pause();
    const body = renderLoopBody(song.buffer, region, { crossfadeMs: seamMs });
    const dur = body.channels[0]!.length / body.sampleRate;
    this.aux = { kind: 'loop', originalStart: body.originalStart, period: dur };
    this.store.set({ previewingId: id, selectedId: id });
    await this.player.playAux(body, { loopStart: 0, loopEnd: dur, offset: 0 });
    if (this.aux?.kind === 'loop' && this.store.get().previewingId === id) this.stopAux();
  }

  async auditionSeam(id: string): Promise<void> {
    const { song, regions, seamMs } = this.store.get();
    if (!song) return;
    const region = regions.find((r) => r.id === id);
    if (!region) return;
    this.stopAux();
    this.player.pause();
    const snip = renderSeamSnippet(song.buffer, region, { crossfadeMs: seamMs });
    this.aux = { kind: 'seam', region: { start: region.start, end: region.end }, seamTime: snip.seamIndex / snip.sampleRate };
    this.store.set({ selectedId: id });
    await this.player.playAux(snip);
    this.aux = null;
    this.renderTime();
  }

  // ---- export ------------------------------------------------------------------

  private openExport(): void {
    const { song } = this.store.get();
    if (!song) return;
    const ext = extendedDuration(this.plan(), song.duration);
    if (ext > MAX_EXTENDED_SECONDS) {
      this.notify(`The extended song is longer than ${MAX_EXTENDED_SECONDS / 60} minutes. Lower a repeat count before exporting.`);
      return;
    }
    const base = song.name.replace(/\.[^./\\]+$/, '');
    this.exportDialog.open({
      defaultName: `${base} (extended).wav`,
      speedPitchNeutral: true,
      speedPitchLabel: '',
      format: `${(song.sampleRate / 1000).toFixed(song.sampleRate % 1000 === 0 ? 0 : 1)} kHz ${song.channels === 1 ? 'mono' : song.channels === 2 ? 'stereo' : `${song.channels} ch`}`,
      estimate: (depth) => {
        const frames = Math.round(ext * song.sampleRate);
        return { bytes: estimateWavSize(frames, song.channels, depth), seconds: ext };
      },
    });
  }

  private async doExport(opts: { filename: string; bitDepth: 16 | 24 | 32; applySpeedPitch: boolean }): Promise<void> {
    const { seamMs } = this.store.get();
    this.exportDialog.setProgress('Rendering…', 0);
    const blob = await this.renderClient.export(
      this.plan(),
      { crossfadeMs: seamMs, bitDepth: opts.bitDepth, stretch: null },
      (stage, pct) => {
        const label = stage === 'render' ? 'Rendering…' : stage === 'stretch' ? 'Applying speed and pitch…' : 'Encoding WAV…';
        this.exportDialog.setProgress(label, pct);
      },
    );
    this.exportDialog.setProgress('Saving…', 1);
    downloadBlob(blob, opts.filename);
  }

  // ---- ticker ------------------------------------------------------------------

  private startTicker(): void {
    cancelAnimationFrame(this.raf);
    if (!this.player.isPlaying() && !this.player.isAuxPlaying()) return;
    const tick = (): void => {
      this.renderTime();
      if (this.player.isPlaying() || this.player.isAuxPlaying()) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private renderTime(): void {
    const { song, playMode } = this.store.get();
    if (!song) return;
    if (this.player.isAuxPlaying() && this.aux) {
      const t = this.player.getAuxTime();
      let orig: number;
      if (this.aux.kind === 'loop') orig = this.aux.originalStart + (t % this.aux.period);
      else orig = t < this.aux.seamTime ? this.aux.region.end - (this.aux.seamTime - t) : this.aux.region.start + (t - this.aux.seamTime);
      this.transport.setTime(orig, song.duration);
      this.waveform?.setCursor(orig, true);
      return;
    }
    const t = this.player.getTime();
    this.transport.setTime(t, this.player.duration);
    const orig = playMode === 'extended' ? extendedToOriginal(this.timeline, t).time : t;
    this.waveform?.setCursor(orig, this.player.isPlaying());
  }
}
