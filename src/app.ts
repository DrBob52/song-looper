import { AnalysisClient, AnalysisSupersededError } from './analysis/client';
import { ANALYSIS_CONFIG } from './analysis/config';
import type { Analysis, AnalysisStage, AnalysisUpdate } from './analysis/types';
import { RENDER_CONFIG } from './audio/config';
import { computePeaks, decodeFile, toMonoAnalysisRate } from './audio/decode';
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
import { solveRepeats } from './audio/target';
import { downloadBlob, estimateWavSize } from './audio/wav';
import { barsBetween, emptyGrid, makeGrid, snapTime } from './grid';
import type { Grid } from './grid';
import type { LoopRegion, Plan, Span } from './model';
import { MAX_EXTENDED_SECONDS } from './model';
import { MIN_REGION_SECONDS, fitSpan, neighbourBounds, newRegionId, nextColor, sortRegions } from './plan';
import { AnalysisControls } from './ui/analysisControls';
import { Dropzone } from './ui/dropzone';
import { h } from './ui/dom';
import { ExportDialog } from './ui/exportDialog';
import { LengthPanel } from './ui/lengthPanel';
import type { LengthMode } from './ui/lengthPanel';
import { RegionsPanel } from './ui/regionsPanel';
import { SuggestionsPanel, suggestionKey } from './ui/suggestionsPanel';
import { TimelineStrip } from './ui/timelineStrip';
import { Transport } from './ui/transport';
import type { PlayMode } from './ui/transport';
import { SELECTION_ID, WaveformView } from './ui/waveform';
import { formatTime } from './util/time';
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
  analysis: Analysis | null;
  analysisState: 'idle' | 'running' | 'done' | 'error';
  grid: Grid;
  lengthMode: LengthMode;
  /** Target extended length in seconds (used in target mode). */
  targetSeconds: number;
}

/** Overall analysis progress (0..1) from a stage and the progress within it. */
function overallProgress(stage: AnalysisStage, pct: number): number {
  const bands: Record<AnalysisStage, [number, number]> = {
    stft: [0, 0.55],
    beats: [0.55, 0.7],
    features: [0.7, 0.8],
    ssm: [0.8, 0.9],
    candidates: [0.9, 1],
  };
  const [a, b] = bands[stage];
  return a + (b - a) * Math.max(0, Math.min(1, pct));
}

function stageLabel(stage: AnalysisStage): string {
  if (stage === 'stft' || stage === 'beats') return 'Finding beats\u2026';
  if (stage === 'features' || stage === 'ssm') return 'Comparing sections\u2026';
  return 'Ranking loops\u2026';
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
    analysis: null,
    analysisState: 'idle',
    grid: emptyGrid(),
    lengthMode: 'repeats',
    targetSeconds: 0,
  });
  readonly player = new Player();
  private renderClient = new RenderClient();
  private analysisClient = new AnalysisClient();
  private analysisControls: AnalysisControls;
  private suggestionsPanel: SuggestionsPanel;
  private timelineStrip: TimelineStrip;
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
    this.analysisControls = new AnalysisControls({
      onTempo: (bpm) => void this.updateAnalysis({ bpm }),
      onMeter: (n) => void this.updateAnalysis({ beatsPerBar: n }),
      onShiftBar: (d) => void this.updateAnalysis({ phaseShift: d }),
    });
    this.suggestionsPanel = new SuggestionsPanel({
      onPreview: (i) => void this.previewCandidate(i),
      onAuditionSeam: (i) => void this.auditionCandidate(i),
      onAdd: (i) => this.addCandidate(i),
      onHover: (i) => {
        const c = i === null ? undefined : this.store.get().analysis?.candidates[i];
        this.waveform?.setHighlight(c ? { start: c.start, end: c.end } : null);
      },
    });
    this.lengthPanel = new LengthPanel({
      onMode: (m) => this.setLengthMode(m),
      onTarget: (sec) => this.setTarget(sec),
      onSeamMs: (ms) => this.store.set({ seamMs: ms }),
    });
    this.timelineStrip = new TimelineStrip((t) => void this.seekExtended(t));
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
          this.analysisControls.el,
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
        this.suggestionsPanel.el,
        this.regionsPanel.el,
        this.lengthPanel.el,
        this.timelineStrip.el,
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
    if (
      regionsChanged ||
      s.selectedId !== prev.selectedId ||
      s.previewingId !== prev.previewingId ||
      s.song !== prev.song ||
      s.grid !== prev.grid ||
      s.lengthMode !== prev.lengthMode
    ) {
      this.regionsPanel.update(s.regions, s.selectedId, {
        barsOf: (r) => barsBetween(s.grid, r.start, r.end),
        hasGrid: s.grid.beats.length > 0,
        previewingId: s.previewingId,
        repeatsLocked: s.lengthMode === 'target',
      });
    }
    if (s.grid !== prev.grid || s.analysis !== prev.analysis) {
      this.waveform?.setGrid(
        s.grid.display ? { beats: s.grid.beats, bars: s.grid.bars } : null,
        (s.analysis?.sections ?? []).map((sec) => ({ start: sec.start, label: sec.label, hint: sec.hint })),
      );
    }
    if (
      s.analysis !== prev.analysis ||
      s.analysisState !== prev.analysisState ||
      s.regions !== prev.regions ||
      s.previewingId !== prev.previewingId ||
      s.song !== prev.song
    ) {
      this.suggestionsPanel.update({
        analysis: s.analysis,
        running: s.analysisState === 'running',
        failed: s.analysisState === 'error',
        regions: s.regions,
        previewingKey: s.previewingId,
        duration: s.song?.duration ?? 0,
      });
    }
    if (s.analysis !== prev.analysis || s.analysisState !== prev.analysisState) {
      this.analysisControls.update(s.analysis, s.analysisState === 'running');
    }
    if (s.selection !== prev.selection) this.waveform?.setSelection(s.selection);
    if (s.playMode !== prev.playMode) this.transport.setMode(s.playMode);
    if (s.notice !== prev.notice) this.noticeEl.textContent = s.notice ?? '';
    if (s.renderState !== prev.renderState) {
      this.transport.setStatus(s.renderState === 'rendering' ? 'Rendering…' : s.renderState === 'error' ? 'Render failed' : '');
    }
    if (
      regionsChanged ||
      s.song !== prev.song ||
      s.seamMs !== prev.seamMs ||
      s.lengthMode !== prev.lengthMode ||
      s.targetSeconds !== prev.targetSeconds
    ) {
      if (s.song) this.timeline = buildTimeline(this.plan(), s.song.duration);
      this.updateLength();
      this.timelineStrip.update(this.timeline, s.regions);
      this.onPlanChanged(regionsChanged || s.seamMs !== prev.seamMs);
    }
  }

  private updateLength(): void {
    const { song, lengthMode, targetSeconds, seamMs, regions } = this.store.get();
    if (!song) return;
    const ext = extendedDuration(this.plan(), song.duration);
    let note = '';
    let noteKind: 'info' | 'warn' = 'info';
    if (ext > MAX_EXTENDED_SECONDS) {
      note = `Too long: the limit is ${MAX_EXTENDED_SECONDS / 60} minutes. Lower a repeat count.`;
      noteKind = 'warn';
    } else if (lengthMode === 'target') {
      if (regions.length === 0) {
        note = 'Add a loop first; the target length is spread across your loops.';
      } else if (targetSeconds <= song.duration) {
        note = 'The target is not longer than the song, so nothing repeats.';
      } else {
        const diff = ext - targetSeconds;
        note =
          Math.abs(diff) < 0.05
            ? `Hits the target: ${formatTime(ext, 1)}.`
            : `Closest whole repeats: ${formatTime(ext, 1)} (${diff > 0 ? '+' : '\u2212'}${Math.abs(diff).toFixed(1)} s from the target).`;
        if (regions.every((r) => r.repeats >= 64) && diff < -0.05) noteKind = 'warn';
      }
    } else if (ext > 20 * 60) {
      note = 'That is a long file. Rendering may be slow.';
    }
    this.lengthPanel.update({
      mode: lengthMode,
      targetSeconds,
      originalSeconds: song.duration,
      extendedSeconds: ext,
      seamMs,
      note,
      noteKind,
      hasRegions: regions.length > 0,
    });
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
        // A running analysis owns the progress bar from here on.
        if (this.store.get().analysisState !== 'running') this.dropzone.hideProgress();
      }
    }
  }

  private stopEverything(): void {
    window.clearTimeout(this.renderTimer);
    this.analysisClient.cancel();
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
      analysis: null,
      analysisState: 'idle',
      grid: emptyGrid(),
      lengthMode: 'repeats',
      targetSeconds: Math.ceil(song.duration),
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
      getSnap: (id) => {
        const s = this.store.get();
        if (s.grid.beats.length === 0) return null;
        const toBars = id === SELECTION_ID ? true : s.regions.find((r) => r.id === id)?.snapToBars !== false;
        return (t) => snapTime(this.store.get().grid, t, toBars);
      },
      getBounds: (id) => {
        const s = this.store.get();
        return id === SELECTION_ID || !s.song ? null : neighbourBounds(s.regions, id, s.song.duration);
      },
      getMinLength: (id) => {
        const s = this.store.get();
        if (s.grid.beats.length === 0) return MIN_REGION_SECONDS;
        const toBars = id === SELECTION_ID ? true : s.regions.find((r) => r.id === id)?.snapToBars !== false;
        return Math.max(MIN_REGION_SECONDS, toBars ? s.grid.barSeconds : s.grid.beatSeconds);
      },
    });
    this.waveform.setZoom(this.store.get().zoom);
    this.waveform.setRegions([], null);
    this.renderTime();
    void this.startAnalysis(song);
  }

  // ---- analysis ----------------------------------------------------------------

  private async startAnalysis(song: DecodedSong): Promise<void> {
    const token = this.loadToken;
    this.analysisClient.cancel();
    this.store.set({ analysisState: 'running', analysis: null, grid: emptyGrid() });
    this.dropzone.showProgress('Finding beats\u2026', 0);
    try {
      const samples = await toMonoAnalysisRate(song.buffer);
      if (token !== this.loadToken) return;
      const analysis = await this.analysisClient.analyze(
        samples,
        ANALYSIS_CONFIG.sampleRate,
        ANALYSIS_CONFIG.bars.beatsPerBar,
        (stage, pct) => {
          if (token === this.loadToken) this.dropzone.showProgress(stageLabel(stage), overallProgress(stage, pct));
        },
      );
      if (token !== this.loadToken) return;
      this.applyAnalysis(analysis);
    } catch (err) {
      if (err instanceof AnalysisSupersededError || token !== this.loadToken) return;
      this.store.set({ analysisState: 'error' });
      this.dropzone.showError(`Analysis failed: ${err instanceof Error ? err.message : String(err)}. You can still add loops by hand.`);
    } finally {
      if (token === this.loadToken) this.dropzone.hideProgress();
    }
  }

  private applyAnalysis(analysis: Analysis): void {
    const song = this.store.get().song;
    if (!song) return;
    this.store.set({ analysis, analysisState: 'done', grid: makeGrid(analysis, song.duration) });
  }

  private async updateAnalysis(change: AnalysisUpdate): Promise<void> {
    const token = this.loadToken;
    this.store.set({ analysisState: 'running' });
    try {
      const analysis = await this.analysisClient.update(change, (stage, pct) => {
        if (token === this.loadToken) this.dropzone.showProgress(stageLabel(stage), overallProgress(stage, pct));
      });
      if (token !== this.loadToken) return;
      this.applyAnalysis(analysis);
    } catch (err) {
      if (err instanceof AnalysisSupersededError || token !== this.loadToken) return;
      this.store.set({ analysisState: 'error' });
      this.notify(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (token === this.loadToken) this.dropzone.hideProgress();
    }
  }

  // ---- regions -----------------------------------------------------------------

  private playheadOriginalTime(): number {
    const t = this.player.getTime();
    return this.store.get().playMode === 'extended' ? extendedToOriginal(this.timeline, t).time : t;
  }

  /** Set the regions, computing repeat counts from the target length when in target mode. */
  private commitRegions(regions: LoopRegion[], extra: Partial<AppState> = {}): void {
    const { song, lengthMode, targetSeconds } = this.store.get();
    let next = sortRegions(regions);
    if (song && lengthMode === 'target' && next.length > 0) {
      const res = solveRepeats(next, song.duration, targetSeconds);
      next = next.map((r, i) => (r.repeats === res.repeats[i] ? r : { ...r, repeats: res.repeats[i]! }));
    }
    this.store.set({ regions: next, ...extra });
  }

  setLengthMode(mode: LengthMode): void {
    const { song, lengthMode, regions } = this.store.get();
    if (!song || mode === lengthMode) return;
    if (mode === 'target') {
      const ext = extendedDuration(this.plan(), song.duration);
      this.store.set({ lengthMode: mode, targetSeconds: Math.max(Math.round(ext), Math.ceil(song.duration)) });
    } else {
      this.store.set({ lengthMode: mode });
    }
    this.commitRegions(regions);
  }

  setTarget(seconds: number): void {
    this.store.set({ targetSeconds: seconds });
    this.commitRegions(this.store.get().regions);
  }

  /** Seek the extended preview (switching to it if needed). */
  async seekExtended(t: number): Promise<void> {
    if (!this.store.get().song) return;
    if (this.store.get().playMode !== 'extended') {
      await this.setPlayMode('extended');
      if (this.store.get().playMode !== 'extended') return;
    }
    if (this.player.isAuxPlaying()) this.stopAux();
    this.player.seek(t);
    this.renderTime();
  }

  addLoop(span?: Span, extra: Partial<LoopRegion> = {}): string | null {
    const { song, regions, selection } = this.store.get();
    if (!song) return null;
    const { grid } = this.store.get();
    let want = span ?? selection;
    if (!want) {
      const at = this.playheadOriginalTime();
      if (grid.steady) {
        const start = snapTime(grid, at, true);
        want = { start, end: Math.min(song.duration, start + 4 * grid.barSeconds) };
      } else {
        want = { start: at, end: Math.min(song.duration, at + Math.min(8, song.duration / 4)) };
      }
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
    this.commitRegions([...regions, region], { selectedId: id, selection: null });
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
        this.commitRegions([...regions]);
        this.notify('Loops cannot overlap. The edit was refused.');
        return;
      }
      next.start = fit.start;
      next.end = fit.end;
    }
    this.commitRegions(regions.map((r) => (r.id === id ? next : r)));
  }

  private setRepeats(id: string, repeats: number): void {
    if (this.store.get().lengthMode === 'target') return;
    this.updateRegion(id, { repeats });
  }

  private selectRegion(id: string): void {
    if (this.store.get().selectedId !== id) this.store.set({ selectedId: id });
  }

  removeRegion(id: string): void {
    const { regions, selectedId, previewingId } = this.store.get();
    if (previewingId === id) this.stopAux();
    this.commitRegions(
      regions.filter((r) => r.id !== id),
      { selectedId: selectedId === id ? null : selectedId },
    );
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
    const region = this.store.get().regions.find((r) => r.id === id);
    if (region) await this.previewSpan(id, region, true);
  }

  async auditionSeam(id: string): Promise<void> {
    const region = this.store.get().regions.find((r) => r.id === id);
    if (region) await this.auditionSpan(id, region);
  }

  async previewCandidate(index: number): Promise<void> {
    const c = this.store.get().analysis?.candidates[index];
    if (c) await this.previewSpan(suggestionKey(index), c, false);
  }

  async auditionCandidate(index: number): Promise<void> {
    const c = this.store.get().analysis?.candidates[index];
    if (c) await this.auditionSpan(suggestionKey(index), c);
  }

  addCandidate(index: number): void {
    const c = this.store.get().analysis?.candidates[index];
    if (!c) return;
    this.addLoop({ start: c.start, end: c.end }, { score: c.score });
  }

  /** Hear a span looping, rendered exactly as the export would (same seam crossfade). Toggles. */
  private async previewSpan(key: string, span: Span, select: boolean): Promise<void> {
    const { song, seamMs, previewingId } = this.store.get();
    if (!song) return;
    if (previewingId === key) {
      this.stopAux();
      return;
    }
    this.stopAux();
    this.player.pause();
    let body: ReturnType<typeof renderLoopBody>;
    try {
      body = renderLoopBody(song.buffer, span, { crossfadeMs: seamMs });
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err));
      return;
    }
    const dur = body.channels[0]!.length / body.sampleRate;
    this.aux = { kind: 'loop', originalStart: body.originalStart, period: dur };
    this.store.set(select ? { previewingId: key, selectedId: key } : { previewingId: key });
    await this.player.playAux(body, { loopStart: 0, loopEnd: dur, offset: 0 });
    if (this.aux?.kind === 'loop' && this.store.get().previewingId === key) this.stopAux();
  }

  /** Hear the jump from the span's end back to its start. */
  private async auditionSpan(key: string, span: Span): Promise<void> {
    const { song, seamMs } = this.store.get();
    if (!song) return;
    this.stopAux();
    this.player.pause();
    let snip: ReturnType<typeof renderSeamSnippet>;
    try {
      snip = renderSeamSnippet(song.buffer, span, { crossfadeMs: seamMs });
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err));
      return;
    }
    this.aux = { kind: 'seam', region: { start: span.start, end: span.end }, seamTime: snip.seamIndex / snip.sampleRate };
    if (this.store.get().regions.some((r) => r.id === key)) this.store.set({ selectedId: key });
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
      this.timelineStrip.setPosition(originalToExtended(this.timeline, orig));
      return;
    }
    const t = this.player.getTime();
    this.transport.setTime(t, this.player.duration);
    const orig = playMode === 'extended' ? extendedToOriginal(this.timeline, t).time : t;
    this.waveform?.setCursor(orig, this.player.isPlaying());
    this.timelineStrip.setPosition(playMode === 'extended' ? t : originalToExtended(this.timeline, t));
  }
}
