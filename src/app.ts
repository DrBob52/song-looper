import { AnalysisClient, AnalysisSupersededError } from './analysis/client';
import { ANALYSIS_CONFIG } from './analysis/config';
import type { Analysis, AnalysisStage, AnalysisUpdate, SeamReport, SeamRequest } from './analysis/types';
import { RENDER_CONFIG } from './audio/config';
import { computePeaks, decodeFile, toMonoAnalysisRate } from './audio/decode';
import type { DecodedSong } from './audio/decode';
import { Player } from './audio/player';
import { loopPath, cycleSeconds } from './audio/path';
import { mapToSource, renderCutSnippet, renderLoopBody, renderSeamSnippet } from './audio/preview';
import type { PreviewRegion, SourceMapEntry } from './audio/preview';
import {
  buildTimeline,
  cutSeconds,
  extendedDuration,
  extendedToOriginal,
  naturalDuration,
  originalToExtended,
  planKey,
  plannedFrames,
} from './audio/render';
import { exportFrames, wavTooLong } from './audio/exportPieces';
import { loopFileLayout, loopFileName, loopFilePlan } from './audio/loopExport';
import { WorkerChunkSource } from './audio/chunkSource';
import { ChunkStream, STREAM_DEFAULTS } from './audio/stream';
import { ExportCancelledError, RenderClient } from './audio/renderClient';
import { noopLabelProvider } from './label/provider';
import type { LabelProvider } from './label/provider';
import { isNeutral } from './audio/stretch';
import { solveRepeats } from './audio/target';
import { estimateWavSize, maxWavFrames } from './audio/wav';
import type { BitDepth } from './audio/wav';
import { saveWav, warmUpSave } from './audio/save';
import { barsBetween, emptyGrid, makeGrid, snapTime } from './grid';
import type { Grid } from './grid';
import type { Cut, Ending, LoopRegion, Plan, SeamPlan, Span } from './model';
import { MAX_REPEATS } from './model';
import {
  MIN_CUT_SECONDS,
  MIN_REGION_SECONDS,
  REAL_ENDING,
  checkEndAt,
  checkFade,
  checkSpanPoints,
  fitSpan,
  freeGaps,
  isSmooth,
  neighbourBounds,
  newCutId,
  newRegionId,
  nextColor,
  sortCuts,
  sortRegions,
  undoSmoothing,
  withSeamPlan,
} from './plan';
import { AnalysisControls } from './ui/analysisControls';
import { CutsPanel } from './ui/cutsPanel';
import { EndingPanel } from './ui/endingPanel';
import type { EndingMode } from './ui/endingPanel';
import { Dropzone } from './ui/dropzone';
import { h } from './ui/dom';
import { ExportDialog } from './ui/exportDialog';
import type { ExportOptions } from './ui/exportDialog';
import { LengthPanel } from './ui/lengthPanel';
import { ColumnLayout } from './ui/layout';
import { NumberField, parsePlainNumber } from './ui/numberField';
import type { LengthMode } from './ui/lengthPanel';
import { RegionsPanel } from './ui/regionsPanel';
import type { Edge, EdgeEdit } from './ui/regionsPanel';
import { SelectionBar } from './ui/selectionBar';
import { SuggestionsPanel, suggestionKey } from './ui/suggestionsPanel';
import { TimelineStrip } from './ui/timelineStrip';
import { Transport } from './ui/transport';
import { PITCH_MAX, PITCH_MIN, SPEED_MAX, SPEED_MIN } from './ui/transport';
import type { PlayMode } from './ui/transport';
import { SkinPicker } from './ui/skinPicker';
import { applySkin, loadSkinChoice, saveSkinChoice } from './ui/skins';
import type { SkinId } from './ui/skins';
import { SELECTION_ID, WaveformView } from './ui/waveform';
import { formatChannels, formatRate } from './util/format';
import { formatClockFloor, formatTime, roundMs } from './util/time';
import { createStore } from './util/store';

/** How long the beat pulse of the Night club skin lasts after each beat, in seconds. */
const BEAT_PULSE_SECONDS = 0.11;

/** The waveform zoom range in pixels per second (0 fits the whole song). */
const ZOOM_MIN_PX = 10;
const ZOOM_MAX_PX = 400;

export interface AppState {
  song: DecodedSong | null;
  regions: LoopRegion[];
  /** Spans of the original song that the extended song skips (SPEC-v1.3.md 2). */
  cuts: Cut[];
  /** Where and how the extended song ends (SPEC-v1.3.md 3). */
  ending: Ending;
  /** Target-length mode: End at follows the target (End exactly at target). */
  endAtTarget: boolean;
  /** A message about the ending, such as that End at was reset (shown in the Ending card until the user acts on it). */
  endingNotice: string | null;
  /** The selected loop or cut (their ids never clash). */
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
  /** Playback speed factor (tempo only) and pitch shift in semitones, for the preview and optionally the export. */
  speed: number;
  pitch: number;
  /** Optional candidate names from the label provider. */
  candidateLabels: string[];
  lengthMode: LengthMode;
  /** Target extended length in seconds (used in target mode). */
  targetSeconds: number;
  /** Seam reports of the loops (harmony, scores, chip) by region id, as the analysis worker last delivered them. */
  seams: Record<string, SeamReport>;
  /** The bit depth chosen last in the export dialog: the length panel says whether the extended song fits at it. */
  bitDepth: BitDepth;
}

/** Identifies the points a seam report belongs to (the report is ignored once the loop has moved). */
function seamKey(r: { start: number; end: number }): string {
  return `${r.start.toFixed(6)}|${r.end.toFixed(6)}`;
}

/** Identifies everything a seam request depends on: the points, the smoothing switch and the room to move. */
function requestKey(q: SeamRequest): string {
  const f = (v: number | undefined): string => (v === undefined ? '' : v.toFixed(6));
  return [f(q.start), f(q.end), q.smooth === false ? 'raw' : 'smooth', q.bridge ? 'bridge' : 'direct', f(q.minStart), f(q.maxEnd)].join('|');
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

/** What is playing in the aux player, with where each stretch of it comes from in the song (for the cursor). */
type AuxInfo =
  | { kind: 'loop'; map: SourceMapEntry[]; sampleRate: number; period: number }
  | { kind: 'seam'; map: SourceMapEntry[]; sampleRate: number };

export class App {
  readonly store = createStore<AppState>({
    song: null,
    regions: [],
    cuts: [],
    ending: REAL_ENDING,
    endAtTarget: false,
    endingNotice: null,
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
    speed: 1,
    pitch: 0,
    candidateLabels: [],
    lengthMode: 'repeats',
    targetSeconds: 0,
    seams: {},
    bitDepth: 16,
  });
  readonly player = new Player();
  private renderClient = new RenderClient();
  private analysisClient = new AnalysisClient();
  private analysisControls: AnalysisControls;
  private suggestionsPanel: SuggestionsPanel;
  private timelineStrip: TimelineStrip;
  /** Swap in an LLM-backed labeller here later; v1 ships the no-op one. */
  labelProvider: LabelProvider = noopLabelProvider;
  private dropzone: Dropzone;
  private transport: Transport;
  private regionsPanel: RegionsPanel;
  private selectionBar: SelectionBar;
  private cutsPanel: CutsPanel;
  private endingPanel: EndingPanel;
  /** The last End at time the user had, so that switching back to End at brings it back. */
  private lastEndAt: number | null = null;
  private lengthPanel: LengthPanel;
  private exportDialog: ExportDialog;
  /** What the open export dialog exports: the extended song, or one loop of its own (SPEC-v1.3.md 7.1). */
  private exportTarget: { kind: 'song' } | { kind: 'loop'; id: string } = { kind: 'song' };
  private songPanel: HTMLElement;
  private appEl!: HTMLElement;
  private skinPicker!: SkinPicker;
  private zoomSlider!: HTMLInputElement;
  private zoomField!: NumberField;
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
  private seamTimer = 0;
  /** What each loop's seam report was last requested for (by region id), see requestKey. */
  private seamKeys = new Map<string, string>();
  private seamInFlight: Promise<void> | null = null;
  /** True while seam plans from the worker are being attached to the loops. */
  private applyingSeams = false;

  constructor(private root: HTMLElement) {
    this.dropzone = new Dropzone((f) => void this.loadFile(f));
    this.transport = new Transport({
      onTogglePlay: () => void this.togglePlay(),
      onMode: (m) => void this.setPlayMode(m),
      onExport: () => this.openExport(),
      onSpeed: (v) => this.setSpeedPitch(v, this.store.get().pitch),
      onPitch: (v) => this.setSpeedPitch(this.store.get().speed, v),
      onResetSpeedPitch: () => this.setSpeedPitch(1, 0),
    });
    this.transport.setEnabled(false);
    // The turntable bar appears once a song is decoded, not before.
    this.transport.el.hidden = true;
    if (typeof AudioWorkletNode === 'undefined') this.transport.setSpeedPitchAvailable(false);
    if (typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') {
      this.dropzone.showError('This browser does not support the Web Audio features Song Looper needs. Try a current Chrome, Edge, Firefox or Safari.');
    }
    this.regionsPanel = new RegionsPanel({
      onAdd: () => this.addLoop(),
      onCutSelection: () => this.cutSelection(),
      onSelect: (id) => this.selectRegion(id),
      onRepeats: (id, n) => this.setRepeats(id, n),
      onEditEdge: (id, edge, edit) => this.editLoopEdge(id, edge, edit),
      onSnapToggle: (id, v) => this.updateRegion(id, { snapToBars: v }),
      onPreviewLoop: (id) => void this.previewLoop(id),
      onAuditionSeam: (id) => void this.auditionSeam(id),
      onAuditionOriginal: (id) => void this.auditionSeam(id, true),
      onSmoothToggle: (id, on) => this.setSmooth(id, on),
      onUndoSeam: (id) => this.undoSeam(id),
      onExportLoop: (id) => void this.openExportLoop(id),
      onBridgeToggle: (id, on) => this.setBridge(id, on),
      onNearbyAudition: (id) => void this.auditionNearby(id),
      onNearbyUse: (id) => this.useNearby(id),
      onRemove: (id) => this.removeRegion(id),
      onHover: (id) => {
        const r = id ? this.store.get().regions.find((x) => x.id === id) : undefined;
        this.waveform?.setHighlight(r ? { start: r.start, end: r.end } : null);
      },
    });
    // the selection bar under the waveform (SPEC-v1.3.md 7.2): typed times, length, Add as loop / Cut / Clear
    this.selectionBar = new SelectionBar({
      onEdit: (edge, seconds) => this.editSelectionEdge(edge, seconds),
      onAddLoop: () => this.addLoop(),
      onCut: () => this.cutSelection(),
      onClear: () => this.store.set({ selection: null }),
    });
    this.cutsPanel = new CutsPanel({
      onSelect: (id) => this.selectRegion(id),
      onEditEdge: (id, edge, edit) => this.editCutEdge(id, edge, edit),
      onAudition: (id) => void this.auditionCut(id),
      onRemove: (id) => this.removeCut(id),
      onHover: (id) => {
        const c = id ? this.store.get().cuts.find((x) => x.id === id) : undefined;
        this.waveform?.setHighlight(c ? { start: c.start, end: c.end } : null);
      },
    });
    this.endingPanel = new EndingPanel({
      onMode: (m) => this.setEndingMode(m),
      checkEndAt: (sec) => this.checkEndAtNow(sec),
      checkFade: (sec) => this.checkFadeNow(sec),
      onEndAt: (sec) => this.setEndAt(sec),
      onEndAtPlayhead: () => this.setEndAtFromPlayhead(),
      onFade: (sec) => this.setFade(sec),
      onEndAtTarget: () => this.endExactlyAtTarget(),
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
    this.exportDialog = new ExportDialog({
      onExport: (o) => this.doExport(o),
      onCancel: () => undefined,
      onCancelExport: () => this.renderClient.cancelExport(),
      onDepth: (bitDepth) => this.store.set({ bitDepth }),
    });
    warmUpSave();
    this.waveHost = h('div', { class: 'wave-host', attrs: { 'data-testid': 'waveform' } });
    this.noticeEl = h('div', { class: 'notice', attrs: { role: 'status', 'data-testid': 'notice' } });

    this.zoomSlider = h('input', {
      attrs: { type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Zoom', 'data-testid': 'zoom' },
      on: { input: (e) => this.setZoom(Number((e.target as HTMLInputElement).value)) },
    });
    this.zoomField = new NumberField({
      id: 'zoom-input',
      label: 'Zoom in pixels per second (fit shows the whole song)',
      testId: 'zoom-input',
      value: 0,
      format: (v) => (v === 0 ? 'fit' : String(v)),
      parse: (text) => {
        if (text.trim().toLowerCase() === 'fit') return 0;
        const n = parsePlainNumber(text, ['px/s', 'px']);
        return n === null ? 'Enter fit, or pixels per second like 80.' : Math.round(n);
      },
      step: (v, dir, mult) => {
        if (v === 0) return dir > 0 ? ZOOM_MIN_PX : 0;
        const next = v + dir * (mult >= 10 ? 50 : mult < 1 ? 1 : 10);
        return next < ZOOM_MIN_PX ? (dir < 0 ? 0 : ZOOM_MIN_PX) : next;
      },
      min: 0,
      max: ZOOM_MAX_PX,
      validate: (v) => (v === 0 || v >= ZOOM_MIN_PX ? null : `Enter fit, or ${ZOOM_MIN_PX} to ${ZOOM_MAX_PX} pixels per second.`),
      width: 5,
      suffix: 'px/s',
      onCommit: (px) => this.setZoomPx(px),
    });
    const toolbar = h('div', { class: 'wave-toolbar' }, [
      h('span', { class: 'field grow' }, [h('label', { text: 'Zoom', attrs: { for: 'zoom-input' } }), this.zoomSlider, this.zoomField.el]),
    ]);
    const waveCard = h('section', { class: 'card', attrs: { 'aria-label': 'Waveform' } }, [
      toolbar,
      this.analysisControls.el,
      this.waveHost,
      this.selectionBar.el,
      h('div', { class: 'wave-hint', attrs: { 'data-testid': 'wave-hint' } }, [
        'Click to seek. Drag on the waveform to select a span (the times appear under it, to type exactly), then press ',
        h('kbd', { text: 'L' }),
        ' to add a loop, or ',
        h('kbd', { text: 'X' }),
        ' to cut it out of the extended song. ',
        h('kbd', { text: 'I' }),
        ' and ',
        h('kbd', { text: 'O' }),
        ' set the start and end of the selected loop or cut (or of the selection) to the playhead. ',
        h('kbd', { text: 'Space' }),
        ' play/pause, ',
        h('kbd', { text: 'Delete' }),
        ' removes the selected loop or cut.',
      ]),
      this.noticeEl,
    ]);
    this.songPanel = h('div', { class: 'song-panel', attrs: { hidden: true, 'data-testid': 'song-panel' } });
    // one column on a narrow window, two columns (SPEC-v1.3.md 4) on a wide one
    new ColumnLayout(this.songPanel, {
      wave: waveCard,
      suggestions: this.suggestionsPanel.el,
      loops: this.regionsPanel.el,
      cuts: this.cutsPanel.el,
      ending: this.endingPanel.el,
      length: this.lengthPanel.el,
      timeline: this.timelineStrip.el,
    });

    // the look: chosen last time (or Vinyl), switched from the picker in the masthead without touching anything else
    const skin = loadSkinChoice();
    applySkin(skin);
    this.skinPicker = new SkinPicker(skin, (id) => this.setSkin(id));
    this.appEl = h('div', { class: 'app' }, [
      h('header', { class: 'top' }, [
        h('div', { class: 'masthead' }, [
          h('h1', { text: 'Song Looper' }),
          h('p', { text: 'Drop in a record. Press an extended cut.' }),
        ]),
        this.skinPicker.el,
      ]),
      this.dropzone.el,
      this.songPanel,
      this.transport.el,
    ]);
    this.root.append(this.appEl, this.exportDialog.el);
    this.trackBarHeight();

    this.player.subscribe(() => {
      this.transport.setPlaying(this.player.isPlaying() || this.player.isAuxPlaying());
      this.startTicker();
      this.renderTime();
    });
    this.store.subscribe((s, prev) => this.onState(s, prev));
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /**
   * The page keeps bottom padding equal to the turntable bar's height while the bar is shown (`--bar-h`, 0 while it is
   * hidden), so the bar never covers the last card when you scroll to the bottom.
   */
  private trackBarHeight(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const bar = this.transport.el;
    const sync = (): void => {
      this.appEl.style.setProperty('--bar-h', `${bar.hidden ? 0 : Math.ceil(bar.getBoundingClientRect().height)}px`);
    };
    new ResizeObserver(sync).observe(bar);
    sync();
  }

  // ---- the look (SPEC-v1.3.md 5) ------------------------------------------------

  /** Switch the look: `data-skin` on <html>, its fonts the first time, remembered for next time. Nothing reloads or stops. */
  setSkin(id: SkinId): void {
    applySkin(id);
    saveSkinChoice(id);
    this.skinPicker.setCurrent(id);
    this.pulseOnBeat(0); // a pulse of the club look must not stay on in another one
    // the waveform re-reads its colours (it also watches data-skin, so this is only to be sure it has done so now)
    this.waveform?.refreshTheme();
  }

  // ---- state -> views ----------------------------------------------------------

  private plan(): Plan {
    const { regions, cuts, ending } = this.store.get();
    return { regions, cuts, ending };
  }

  /** Everything that occupies a span of the song: loops and cuts block each other and the seam smoother's room. */
  private obstacles(): { id: string; start: number; end: number }[] {
    const { regions, cuts } = this.store.get();
    return [...regions, ...cuts];
  }

  private onState(s: AppState, prev: AppState): void {
    const regionsChanged = s.regions !== prev.regions;
    const cutsChanged = s.cuts !== prev.cuts;
    if (regionsChanged || cutsChanged || s.selectedId !== prev.selectedId || s.song !== prev.song) {
      this.waveform?.setRegions(s.regions, s.selectedId, s.cuts);
    }
    if (cutsChanged || s.selectedId !== prev.selectedId || s.song !== prev.song || s.grid !== prev.grid) {
      this.cutsPanel.update(s.cuts, s.selectedId, {
        barsOf: (c) => barsBetween(s.grid, c.start, c.end),
        steadyBeat: s.grid.steady,
        duration: s.song?.duration ?? 0,
      });
    }
    if (
      regionsChanged ||
      s.selectedId !== prev.selectedId ||
      s.previewingId !== prev.previewingId ||
      s.song !== prev.song ||
      s.grid !== prev.grid ||
      s.lengthMode !== prev.lengthMode ||
      s.seams !== prev.seams
    ) {
      this.regionsPanel.update(s.regions, s.selectedId, {
        barsOf: (r) => barsBetween(s.grid, r.start, r.end),
        hasGrid: s.grid.beats.length > 0,
        steadyBeat: s.grid.steady,
        previewingId: s.previewingId,
        repeatsLocked: s.lengthMode === 'target',
        seamOf: (r) => {
          const report = s.seams[r.id];
          return report && seamKey(report) === seamKey(r) ? report : null;
        },
        nearbyOf: (r) => {
          const report = s.seams[r.id];
          return report && seamKey(report) === seamKey(r) ? report.nearby : null;
        },
        bridgeOf: (r) => {
          const report = s.seams[r.id];
          return report && seamKey(report) === seamKey(r) ? report.bridge : null;
        },
      });
    }
    if (regionsChanged || cutsChanged || s.analysis !== prev.analysis || s.analysisState !== prev.analysisState) this.scheduleSeamReports();
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
      s.candidateLabels !== prev.candidateLabels ||
      s.song !== prev.song
    ) {
      this.suggestionsPanel.update({
        labels: s.candidateLabels,
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
    const endingChanged = s.ending !== prev.ending || s.endAtTarget !== prev.endAtTarget || s.endingNotice !== prev.endingNotice;
    if (endingChanged || regionsChanged || cutsChanged || s.song !== prev.song || s.lengthMode !== prev.lengthMode) this.updateEndingPanel();
    if (s.selection !== prev.selection) this.waveform?.setSelection(s.selection);
    if (s.selection !== prev.selection || s.grid !== prev.grid || s.song !== prev.song) this.updateSelectionBar();
    if (s.playMode !== prev.playMode) this.transport.setMode(s.playMode);
    if (s.notice !== prev.notice) this.noticeEl.textContent = s.notice ?? '';
    if (s.renderState !== prev.renderState) {
      this.transport.setStatus(s.renderState === 'rendering' ? 'Rendering…' : s.renderState === 'error' ? 'Render failed' : '');
    }
    if (
      regionsChanged ||
      cutsChanged ||
      endingChanged ||
      s.song !== prev.song ||
      s.seamMs !== prev.seamMs ||
      s.lengthMode !== prev.lengthMode ||
      s.targetSeconds !== prev.targetSeconds
    ) {
      if (s.song) this.timeline = buildTimeline(this.plan(), s.song.duration);
      this.updateLength();
      this.timelineStrip.update(this.timeline, s.regions, s.ending);
      this.onPlanChanged(regionsChanged || cutsChanged || s.ending !== prev.ending || s.seamMs !== prev.seamMs);
    } else if (s.bitDepth !== prev.bitDepth) {
      this.updateLength();
    }
    // a shorter song may no longer reach the end point: the song ends at its real ending again, with a notice
    if (regionsChanged || cutsChanged || s.song !== prev.song) this.enforceEnding();
  }

  /** The most seconds of extended song a WAV can hold for this song's channels and sample rate at a bit depth. */
  private wavCapSeconds(depth: BitDepth): number {
    const { song } = this.store.get();
    return song ? maxWavFrames(song.channels, depth) / song.sampleRate : Infinity;
  }

  /** Why the extended song cannot be written as a WAV at this depth (a message), or null. */
  private tooLongFor(depth: BitDepth, frames: number): string | null {
    const { song } = this.store.get();
    return song ? wavTooLong(frames, song.sampleRate, song.channels, depth) : null;
  }

  private updateLength(): void {
    const { song, lengthMode, targetSeconds, seamMs, regions, bitDepth } = this.store.get();
    if (!song) return;
    const ext = extendedDuration(this.plan(), song.duration);
    // the song without its cuts: what the loops' repeats are added to
    const base = song.duration - cutSeconds(this.plan(), song.duration);
    let note = '';
    let noteKind: 'info' | 'warn' = 'info';
    // a song too long for a WAV at any depth cannot be exported; one that only fits at 16-bit says so when 24 or 32 is chosen
    const frames = this.plannedFrames();
    const noExport = this.tooLongFor(16, frames);
    const tooLong = noExport ?? this.tooLongFor(bitDepth, frames);
    if (tooLong) {
      note = tooLong;
      noteKind = 'warn';
    } else if (lengthMode === 'target') {
      if (regions.length === 0) {
        note = 'Add a loop first; the target length is spread across your loops.';
      } else if (targetSeconds <= base) {
        note = 'The target is not longer than the song, so nothing repeats.';
      } else {
        const diff = ext - targetSeconds;
        note =
          Math.abs(diff) < 0.05
            ? `Hits the target: ${formatTime(ext, 1)}.`
            : `Closest whole repeats: ${formatTime(ext, 1)} (${diff > 0 ? '+' : '\u2212'}${Math.abs(diff).toFixed(1)} s from the target).`;
        if (regions.every((r) => r.repeats >= MAX_REPEATS) && diff < -0.05) noteKind = 'warn';
      }
    } else if (ext > 20 * 60) {
      note = 'That is a long file. Export renders it in pieces, so it needs little memory, but it takes a while.';
    }
    this.transport.setExportBlocked(noExport);
    this.lengthPanel.update({
      mode: lengthMode,
      targetSeconds,
      originalSeconds: song.duration,
      extendedSeconds: ext,
      endAt: this.store.get().ending.endAt,
      fadeSeconds: this.store.get().ending.fadeSeconds,
      seamMs,
      note,
      noteKind,
      hasRegions: regions.length > 0,
      capSeconds: this.wavCapSeconds(16),
      capMessage: `Too long for a WAV at 16-bit (max ${formatClockFloor(this.wavCapSeconds(16))}). Enter a shorter length.`,
    });
  }

  private onPlanChanged(contentChanged: boolean): void {
    if (!contentChanged) return;
    this.extendedKey = null;
    // A seam plan arriving from the worker only refines how a loop plays: it must not cut off a preview that is running.
    if (this.player.isAuxPlaying() && !this.applyingSeams) this.stopAux();
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
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      this.cutSelection();
    } else if (e.key === 'i' || e.key === 'I' || e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      this.markFromPlayhead(e.key === 'i' || e.key === 'I' ? 'start' : 'end');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const { selectedId, selection, cuts } = this.store.get();
      if (selectedId && cuts.some((c) => c.id === selectedId)) {
        e.preventDefault();
        this.removeCut(selectedId);
      } else if (selectedId) {
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
    this.dropzone.showWarning(null);
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
      cuts: [],
      ending: REAL_ENDING,
      endAtTarget: false,
      endingNotice: null,
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
      seams: {},
    });
    this.seamKeys.clear();
    this.lastEndAt = null;
    this.dropzone.showFile(song);
    this.dropzone.showWarning(
      song.duration > ANALYSIS_CONFIG.limits.longSongSeconds
        ? `This song is ${Math.round(song.duration / 60)} minutes long. Analysis, preview and export may be slow and use a lot of memory, but the app will still try.`
        : null,
    );
    this.songPanel.hidden = false;
    this.transport.el.hidden = false;
    this.transport.setEnabled(true);

    const peaks = computePeaks(song.buffer, 100);
    this.waveform = new WaveformView(this.waveHost, peaks, song.duration, {
      onSeek: (t) => this.seekOriginal(t),
      onSelection: (sel) => this.store.set({ selection: sel }),
      // while a selection is being dragged the bar follows it, before the store has the final span
      onSelectionLive: (sel) => this.selectionBar.update(sel, { barsOf: (span) => barsBetween(this.store.get().grid, span.start, span.end) }),
      onRegionEdit: (id, start, end) => this.updateRegion(id, { start, end }),
      onCutEdit: (id, start, end) => this.updateCut(id, { start, end }),
      onRegionSelect: (id) => this.selectRegion(id),
      getSnap: (id) => {
        const s = this.store.get();
        if (s.grid.beats.length === 0) return null;
        // bars by default for selections and cuts; a loop can be set to beats
        const toBars = id === SELECTION_ID || s.cuts.some((c) => c.id === id) ? true : s.regions.find((r) => r.id === id)?.snapToBars !== false;
        return (t) => snapTime(this.store.get().grid, t, toBars);
      },
      getBounds: (id) => {
        const s = this.store.get();
        return id === SELECTION_ID || !s.song ? null : neighbourBounds(this.obstacles(), id, s.song.duration);
      },
      getMinLength: (id, free) => {
        const s = this.store.get();
        const isCut = s.cuts.some((c) => c.id === id);
        const min = isCut ? MIN_CUT_SECONDS : MIN_REGION_SECONDS;
        // Shift-dragging (free, no snapping) may go as short as the shortest cut or loop
        if (s.grid.beats.length === 0 || (isCut && free)) return min;
        const toBars = id === SELECTION_ID || isCut ? true : s.regions.find((r) => r.id === id)?.snapToBars !== false;
        return Math.max(min, toBars ? s.grid.barSeconds : s.grid.beatSeconds);
      },
    });
    this.waveform.setZoom(this.store.get().zoom);
    this.waveform.setRegions([], null, []);
    this.renderTime();
    void this.startAnalysis(song);
  }

  // ---- analysis ----------------------------------------------------------------

  private async startAnalysis(song: DecodedSong): Promise<void> {
    const token = this.loadToken;
    this.analysisClient.cancel();
    this.store.set({ analysisState: 'running', analysis: null, grid: emptyGrid(), seams: {} });
    this.seamKeys.clear();
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
    this.seamKeys.clear();
    const fresh: Partial<AppState> = {
      analysis,
      analysisState: 'done',
      grid: makeGrid(analysis, song.duration),
      candidateLabels: [],
      seams: {},
    };
    // Seam plans were made for the old beats (tempo, meter, bar lines): drop them, and the reports asked for above
    // bring new ones. Going through commitRegions keeps the repeat counts of target-length mode in step (a bridge
    // that goes away changes the length of a cycle).
    const regions = this.store.get().regions;
    if (regions.some((r) => r.seam)) this.commitRegions(regions.map(({ seam: _plan, ...r }) => r), fresh);
    else this.store.set(fresh);
    // Optional labeller (no-op by default); a failure only means "no labels".
    const token = this.loadToken;
    this.labelProvider
      .label(analysis, analysis.candidates)
      .then((labels) => {
        if (token === this.loadToken && this.store.get().analysis === analysis) this.store.set({ candidateLabels: labels });
      })
      .catch(() => undefined);
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

  // ---- seam reports ------------------------------------------------------------

  private requestFor(r: LoopRegion, regions: readonly { id: string; start: number; end: number }[], duration: number): SeamRequest {
    // the room around a loop is bounded by its neighbours, cuts included: smoothing never moves a loop into a cut
    const room = neighbourBounds(regions, r.id, duration);
    return { id: r.id, start: r.start, end: r.end, smooth: isSmooth(r), bridge: r.bridge === true, minStart: room.start, maxEnd: room.end };
  }

  /** Does any loop need a (new) seam report? */
  private needsSeamReports(): boolean {
    const { regions, analysis, analysisState, song } = this.store.get();
    if (!song || !analysis || analysis.silent || analysisState === 'running') return false;
    const around = this.obstacles();
    return regions.some((r) => this.seamKeys.get(r.id) !== requestKey(this.requestFor(r, around, song.duration)));
  }

  /** Ask the analysis worker how the loops' seams sound and how to smooth them, shortly after the loops or the analysis change. */
  private scheduleSeamReports(): void {
    window.clearTimeout(this.seamTimer);
    this.seamTimer = 0;
    if (!this.needsSeamReports() && !this.pruneSeams(false)) return;
    this.seamTimer = window.setTimeout(() => {
      this.seamTimer = 0;
      void this.runSeamReports();
    }, 120);
  }

  /** Forget the reports of loops that are gone. Returns whether anything is left to forget (or was, when `apply`). */
  private pruneSeams(apply: boolean): boolean {
    const { regions, seams } = this.store.get();
    const ids = new Set(regions.map((r) => r.id));
    for (const id of [...this.seamKeys.keys()]) if (!ids.has(id)) this.seamKeys.delete(id);
    const gone = Object.keys(seams).filter((id) => !ids.has(id));
    if (gone.length && apply) this.store.set({ seams: Object.fromEntries(Object.entries(seams).filter(([id]) => ids.has(id))) });
    return gone.length > 0;
  }

  private runSeamReports(): Promise<void> {
    this.seamInFlight = this.doSeamReports().finally(() => {
      this.seamInFlight = null;
    });
    return this.seamInFlight;
  }

  private async doSeamReports(): Promise<void> {
    this.pruneSeams(true);
    if (!this.needsSeamReports()) return;
    const { regions, song } = this.store.get();
    if (!song) return;
    const around = this.obstacles();
    const requests = regions.map((r) => this.requestFor(r, around, song.duration));
    for (const q of requests) this.seamKeys.set(q.id, requestKey(q));
    const token = this.loadToken;
    try {
      const reports = await this.analysisClient.seamReport(requests);
      if (token !== this.loadToken) return;
      this.applySeamReports(requests, reports);
    } catch (err) {
      if (err instanceof AnalysisSupersededError) return;
      // A failed report only means there is no chip and no smoothing.
      for (const q of requests) this.seamKeys.delete(q.id);
    }
  }

  /** Keep each report (and the seam plan in it) that still fits its loop: same points, same switches, same room. */
  private applySeamReports(requests: SeamRequest[], reports: SeamReport[]): void {
    const now = this.store.get();
    if (!now.song) return;
    const sent = new Map(requests.map((q) => [q.id, requestKey(q)]));
    const seams = { ...now.seams };
    let regionsChanged = false;
    const regions = now.regions.map((r) => {
      const report = reports.find((x) => x.id === r.id);
      if (!report || sent.get(r.id) !== requestKey(this.requestFor(r, [...now.regions, ...now.cuts], now.song!.duration))) return r;
      seams[r.id] = report;
      const next = report.plan && (isSmooth(r) || r.bridge === true) ? withSeamPlan(r, report.plan) : r;
      if (next !== r) regionsChanged = true;
      return next;
    });
    this.store.set({ seams });
    if (regionsChanged) {
      this.applyingSeams = true;
      try {
        this.commitRegions(regions);
      } finally {
        this.applyingSeams = false;
      }
    }
  }

  /** Resolves once every loop's seam plan is in (so that previews and the export use what the user sees). */
  async seamsSettled(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (this.seamTimer) {
        window.clearTimeout(this.seamTimer);
        this.seamTimer = 0;
        await this.runSeamReports();
      } else if (this.seamInFlight) {
        await this.seamInFlight;
      } else if (this.needsSeamReports()) {
        await this.runSeamReports();
      } else return;
    }
  }

  /** The seam plan for an arbitrary span (a suggestion), computed by the worker; null when smoothing cannot be done. */
  private async planFor(id: string, span: Span): Promise<SeamPlan | null> {
    const { analysis, song, regions } = this.store.get();
    if (!analysis || analysis.silent || !song) return null;
    try {
      const room = neighbourBounds(regions, '', song.duration);
      const [report] = await this.analysisClient.seamReport(
        [{ id, start: span.start, end: span.end, smooth: true, minStart: room.start, maxEnd: room.end }],
        'preview',
      );
      return report?.plan ?? null;
    } catch {
      return null;
    }
  }

  // ---- regions -----------------------------------------------------------------

  /** Where the playhead is in the original song, whatever is playing (the song, the extended cut or a preview). */
  private originalPlayhead(): number {
    const { playMode } = this.store.get();
    if (this.player.isAuxPlaying() && this.aux) {
      const t = this.player.getAuxTime();
      const at = this.aux.kind === 'loop' ? t % this.aux.period : t;
      return mapToSource(this.aux.map, Math.round(at * this.aux.sampleRate), this.aux.sampleRate);
    }
    const t = this.player.getTime();
    return playMode === 'extended' ? extendedToOriginal(this.timeline, t).time : t;
  }

  /** Length of a new loop that has no span of its own: 4 bars, or 8 s when there are no bars (never over half the song). */
  private defaultLoopSeconds(): number {
    const { grid, song } = this.store.get();
    const duration = song?.duration ?? 8;
    return grid.steady ? Math.min(4 * grid.barSeconds, duration / 2) : Math.min(8, duration / 2);
  }

  /**
   * Frames in the extended song as it will be rendered: the timeline's length, adjusted for the few samples by which
   * the edges of each loop snap to zero crossings (which add up over thousands of repeats).
   */
  private plannedFrames(
    regions: readonly LoopRegion[] = this.store.get().regions,
    cuts: readonly Cut[] = this.store.get().cuts,
    ending: Ending = this.store.get().ending,
  ): number {
    const { song } = this.store.get();
    if (!song) return 0;
    return plannedFrames(song.buffer, { regions: [...regions], cuts: [...cuts], ending });
  }

  /** Set the regions, computing repeat counts from the target length when in target mode. */
  private commitRegions(regions: LoopRegion[], extra: Partial<AppState> = {}): void {
    const { song, lengthMode, targetSeconds } = this.store.get();
    const cuts = extra.cuts ?? this.store.get().cuts;
    const ending = extra.ending ?? this.store.get().ending;
    const exactEnd = ending.endAt !== null && (extra.endAtTarget ?? this.store.get().endAtTarget);
    let next = sortRegions(regions);
    if (song && lengthMode === 'target' && next.length > 0) {
      // never longer than a WAV can hold (at 16-bit, the deepest it can go)
      const cap = maxWavFrames(song.channels, 16);
      // the repeats are added to the song without its cuts
      const base = song.duration - cutSeconds({ regions: next, cuts }, song.duration);
      // End exactly at target: the song must reach the target (it is trimmed to it), and what it plays past it is not heard
      const res = solveRepeats(
        next.map((r) => ({ start: r.start, end: r.end, score: r.score, extra: cycleSeconds(loopPath(r)) - (r.end - r.start) })),
        base,
        targetSeconds,
        exactEnd ? Infinity : cap / song.sampleRate,
        exactEnd ? targetSeconds : 0,
      );
      next = next.map((r, i) => (r.repeats === res.repeats[i] ? r : { ...r, repeats: res.repeats[i]! }));
      // the few samples lost to zero-crossing snaps can add up to a second or two over thousands of repeats
      for (let guard = 0; guard < 50 && this.plannedFrames(next, cuts, ending) > cap; guard++) {
        let pick = -1;
        next.forEach((r, i) => {
          if (r.repeats > 1 && (pick < 0 || r.end - r.start > next[pick]!.end - next[pick]!.start)) pick = i;
        });
        if (pick < 0) break;
        next = next.map((r, i) => (i === pick ? { ...r, repeats: r.repeats - 1 } : r));
      }
    }
    this.store.set({ regions: next, ...extra });
  }

  /** Preview speed (tempo only, 0.5x to 1.5x, to 0.01) and pitch (-12 to +12 semitones, decimals allowed). */
  setSpeedPitch(speed: number, pitch: number): void {
    const sp = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) * 100) / 100;
    const pt = Math.round(Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch)) * 100) / 100;
    this.store.set({ speed: sp, pitch: pt });
    this.transport.setSpeedPitch(sp, pt);
    void this.player.setSpeedPitch(sp, pt).catch((err: unknown) => {
      this.notify(`Speed/pitch is not available: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  setLengthMode(mode: LengthMode): void {
    const { song, lengthMode, regions } = this.store.get();
    if (!song || mode === lengthMode) return;
    if (mode === 'target') {
      const ext = extendedDuration(this.plan(), song.duration);
      const base = song.duration - cutSeconds(this.plan(), song.duration);
      this.store.set({ lengthMode: mode, targetSeconds: Math.max(Math.round(ext), Math.ceil(base)) });
    } else {
      // End at stays as a plain time once the target no longer drives it
      this.store.set({ lengthMode: mode, endAtTarget: false });
    }
    this.commitRegions(regions);
  }

  setTarget(seconds: number): void {
    const { ending, endAtTarget, regions } = this.store.get();
    this.store.set({ targetSeconds: seconds });
    // End exactly at target: the end point follows the target
    if (endAtTarget && ending.endAt !== null) this.commitRegions(regions, { ending: { ...ending, endAt: seconds } });
    else this.commitRegions(regions);
  }

  // ---- the ending (SPEC-v1.3.md 3) ---------------------------------------------------

  /** Length of the extended song in seconds before the end point trims it: what End at is measured on. */
  private naturalSeconds(): number {
    const { song, regions, cuts } = this.store.get();
    return song ? naturalDuration({ regions, cuts }, song.duration) : 0;
  }

  private updateEndingPanel(): void {
    const { song, ending, lengthMode, endAtTarget, endingNotice } = this.store.get();
    if (!song) return;
    const natural = this.naturalSeconds();
    this.endingPanel.update({
      mode: ending.endAt === null ? 'real' : 'at',
      endAt: ending.endAt ?? roundMs(natural),
      fadeSeconds: ending.fadeSeconds,
      natural,
      targetMode: lengthMode === 'target',
      followsTarget: endAtTarget,
      notice: endingNotice,
    });
  }

  private checkEndAtNow(seconds: number): string | null {
    return checkEndAt(seconds, this.store.get().ending.fadeSeconds, this.naturalSeconds());
  }

  private checkFadeNow(seconds: number): string | null {
    return checkFade(seconds, this.store.get().ending.endAt, this.naturalSeconds());
  }

  /** Real ending, or End at (the last time the user had, or the end of the song). */
  setEndingMode(mode: EndingMode): void {
    const { song, ending } = this.store.get();
    if (!song) return;
    if (mode === 'real') {
      if (ending.endAt !== null) this.lastEndAt = ending.endAt;
      this.store.set({ ending: { endAt: null, fadeSeconds: ending.fadeSeconds }, endAtTarget: false, endingNotice: null });
      return;
    }
    if (ending.endAt !== null) return;
    const natural = this.naturalSeconds();
    const fits = this.lastEndAt !== null && this.lastEndAt <= natural + 5e-4 && this.lastEndAt >= ending.fadeSeconds;
    const endAt = fits ? this.lastEndAt! : Math.floor(natural * 1000) / 1000;
    this.store.set({ ending: { endAt, fadeSeconds: ending.fadeSeconds }, endingNotice: null });
  }

  /** A typed End at time on the extended timeline. Returns the reason when refused. */
  setEndAt(seconds: number): string | null {
    const refused = this.checkEndAtNow(seconds);
    if (refused) return refused;
    const { ending } = this.store.get();
    this.lastEndAt = seconds;
    this.store.set({ ending: { endAt: seconds, fadeSeconds: ending.fadeSeconds }, endAtTarget: false, endingNotice: null });
    return null;
  }

  /** End at = where the playhead is on the extended timeline (the extended song's own clock, or the mapped original). */
  setEndAtFromPlayhead(): string | null {
    const { song, playMode } = this.store.get();
    if (!song) return 'Load a song first.';
    const t = playMode === 'extended' && !this.player.isAuxPlaying() ? this.player.getTime() : originalToExtended(this.timeline, this.originalPlayhead());
    return this.setEndAt(roundMs(t));
  }

  /** A typed or slid fade length. Returns the reason when refused. */
  setFade(seconds: number): string | null {
    const refused = this.checkFadeNow(seconds);
    if (refused) return refused;
    const { ending } = this.store.get();
    this.store.set({ ending: { endAt: ending.endAt, fadeSeconds: seconds }, endingNotice: null });
    return null;
  }

  /** Target-length mode: End at = the target, repeats solved to reach at least the target, so the song is trimmed to it exactly. */
  endExactlyAtTarget(): void {
    const { song, lengthMode, targetSeconds, ending, regions } = this.store.get();
    if (!song || lengthMode !== 'target' || regions.length === 0) return;
    const fade = Math.min(ending.fadeSeconds, targetSeconds);
    this.lastEndAt = targetSeconds;
    this.commitRegions(regions, { ending: { endAt: targetSeconds, fadeSeconds: fade }, endAtTarget: true, endingNotice: null });
  }

  /**
   * After the loops or cuts changed: an End at beyond the new, shorter song goes back to the real ending (with a notice),
   * and a fade longer than the song up to its end is cut to fit.
   */
  private enforceEnding(): void {
    const { song, ending, endAtTarget, endingNotice } = this.store.get();
    if (!song) return;
    const natural = this.naturalSeconds();
    let next = ending;
    let notice: string | null = null;
    if (ending.endAt !== null && ending.endAt > natural + 5e-4) {
      next = { endAt: null, fadeSeconds: ending.fadeSeconds };
      notice = 'End point was past the new ending, so the song now ends at its real ending.';
    }
    const limit = next.endAt ?? natural;
    if (next.fadeSeconds > limit + 1e-9) {
      const fade = Math.max(0, Math.floor(limit * 10) / 10);
      next = { ...next, fadeSeconds: fade };
      notice ??= `The fade was longer than the song, so it is now ${fade} s.`;
    }
    if (next === ending) return;
    this.store.set({ ending: next, endAtTarget: next.endAt === null ? false : endAtTarget, endingNotice: notice ?? endingNotice });
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
      const at = this.originalPlayhead();
      const len = this.defaultLoopSeconds();
      if (grid.steady) {
        let start = snapTime(grid, at, true);
        // near the end of the song the loop ends there and starts one default length before it
        if (start + len > song.duration) start = snapTime(grid, Math.max(0, song.duration - len), true);
        want = { start, end: Math.min(song.duration, start + len) };
      } else {
        const start = Math.min(at, Math.max(0, song.duration - len));
        want = { start, end: Math.min(song.duration, start + len) };
      }
    }
    const fit = fitSpan(this.obstacles(), want, song.duration, MIN_REGION_SECONDS);
    if (!fit) {
      this.notify('That span overlaps an existing loop or cut, or is too short. Select a free span and try again.');
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
      const fit = fitSpan(this.obstacles(), { start: next.start, end: next.end }, song.duration, MIN_REGION_SECONDS, id);
      if (!fit) {
        // Refuse: snap the view back to the model.
        this.commitRegions([...regions]);
        this.notify('Loops cannot overlap each other or a cut. The edit was refused.');
        return;
      }
      next.start = fit.start;
      next.end = fit.end;
    }
    // What the seam smoother decided belongs to the points and switches it was computed for.
    if (patch.start !== undefined || patch.end !== undefined || patch.smooth !== undefined || patch.bridge !== undefined) {
      delete next.seam;
      this.seamKeys.delete(id); // a new plan has to be asked for
    }
    this.commitRegions(regions.map((r) => (r.id === id ? next : r)));
  }

  /** The Smooth seam checkbox of a loop. Turning it off is the same as Undo. */
  setSmooth(id: string, on: boolean): void {
    // switching it back on hands the join to the smoother again, so the points are no longer "exactly as typed"
    this.updateRegion(id, on ? { smooth: true, exact: false } : { smooth: false });
  }

  // ---- exact loop times (SPEC-v1.2.md 1) -------------------------------------------

  /** Length of the analysed beat starting at `t` (dir 1) or ending at it (dir -1), or null when there is no steady beat. */
  private beatLengthAt(t: number, dir: 1 | -1): number | null {
    const { grid } = this.store.get();
    if (!grid.steady || grid.beats.length < 2) return null;
    const beats = grid.beats;
    const x = dir > 0 ? t : t - 1e-6;
    let lo = 0;
    let hi = beats.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid]! <= x) lo = mid;
      else hi = mid - 1;
    }
    return beats[lo + 1]! - beats[lo]!;
  }

  /** Why a loop with these points is not allowed, or null. Exact times are never clamped: a bad one is refused. */
  private checkLoopPoints(id: string, start: number, end: number, edge: Edge): string | null {
    const { song, regions, cuts } = this.store.get();
    if (!song) return 'Load a song first.';
    return checkSpanPoints({ what: 'loop', id, start, end, edge, duration: song.duration, regions, cuts });
  }

  /**
   * Move a loop's start or end to an exact time: typed, nudged or taken from the playhead. The time is used as given
   * (never snapped, never clamped; refused when it is not allowed) and Smooth seam is turned off for the loop, so it
   * plays exactly these times. Returns the reason when refused, null when applied.
   */
  editLoopEdge(id: string, edge: Edge, edit: EdgeEdit): string | null {
    const { song, regions } = this.store.get();
    if (!song) return 'Load a song first.';
    const region = regions.find((r) => r.id === id);
    if (!region) return 'That loop is gone.';
    const current = region[edge];
    let value: number;
    if (edit.type === 'time') value = edit.seconds;
    else if (edit.type === 'ms') value = current + edit.delta;
    else if (edit.type === 'beat') {
      const len = this.beatLengthAt(current, edit.dir);
      if (len === null) return 'There is no steady beat to nudge by.';
      value = current + edit.dir * len;
    } else value = this.originalPlayhead();
    value = roundMs(value);
    const start = edge === 'start' ? value : region.start;
    const end = edge === 'end' ? value : region.end;
    const refused = this.checkLoopPoints(id, start, end, edge);
    if (refused) return refused;
    if (Math.round(value * 1000) === Math.round(current * 1000)) return null;
    const next: LoopRegion = { ...region, start, end, smooth: false, exact: true };
    delete next.seam;
    this.seamKeys.delete(id);
    this.commitRegions(regions.map((r) => (r.id === id ? next : r)));
    return null;
  }

  /** I and O: the playhead becomes the start or end of the selected loop, or of the waveform selection. */
  private markFromPlayhead(edge: Edge): void {
    const { song, selectedId, regions, cuts, selection } = this.store.get();
    if (!song) return;
    if (selectedId && cuts.some((c) => c.id === selectedId)) {
      const refused = this.editCutEdge(selectedId, edge, { type: 'playhead' });
      if (refused) this.notify(refused);
      return;
    }
    if (selectedId && regions.some((r) => r.id === selectedId)) {
      const refused = this.editLoopEdge(selectedId, edge, { type: 'playhead' });
      if (refused) this.notify(refused);
      return;
    }
    const t = roundMs(this.originalPlayhead());
    const keep = selection ? selection.end - selection.start : this.defaultLoopSeconds();
    let next: Span;
    if (edge === 'start') {
      next = selection && t < selection.end - MIN_REGION_SECONDS ? { start: t, end: selection.end } : { start: t, end: Math.min(song.duration, roundMs(t + keep)) };
    } else {
      next = selection && t > selection.start + MIN_REGION_SECONDS ? { start: selection.start, end: t } : { start: Math.max(0, roundMs(t - keep)), end: t };
    }
    if (next.end - next.start < MIN_REGION_SECONDS - 1e-9) {
      this.notify('The selection would be too short there. Move the playhead and try again.');
      return;
    }
    this.store.set({ selection: next });
  }

  private updateSelectionBar(): void {
    const { selection, grid } = this.store.get();
    this.selectionBar.update(selection, { barsOf: (span) => barsBetween(grid, span.start, span.end) });
  }

  /**
   * A typed (or stepped) start or end of the waveform selection (SPEC-v1.3.md 7.2): exact, never snapped, with the loop
   * fields' checks and messages (a selection may overlap a loop or cut: Add as loop and Cut say so when it matters).
   * Returns the reason when refused, null when applied.
   */
  editSelectionEdge(edge: Edge, seconds: number): string | null {
    const { song, selection } = this.store.get();
    if (!song) return 'Load a song first.';
    if (!selection) return 'There is no selection.';
    const value = roundMs(seconds);
    const start = edge === 'start' ? value : selection.start;
    const end = edge === 'end' ? value : selection.end;
    const refused = checkSpanPoints({ what: 'selection', id: 'selection', start, end, edge, duration: song.duration, regions: [], cuts: [] });
    if (refused) return refused;
    if (start !== selection.start || end !== selection.end) this.store.set({ selection: { start, end } });
    return null;
  }

  /** The nearby loop with a cleaner chord change that the seam report found for a loop, if it still applies. */
  private nearbyOf(id: string): { start: number; end: number } | null {
    const { regions, seams } = this.store.get();
    const region = regions.find((r) => r.id === id);
    const report = seams[id];
    return region && report && seamKey(report) === seamKey(region) ? report.nearby : null;
  }

  /** Hear the (smoothed) seam of the nearby loop: it is only a suggestion until the user clicks Use. */
  async auditionNearby(id: string): Promise<void> {
    const nearby = this.nearbyOf(id);
    if (!nearby) return;
    const key = `nearby-${id}`;
    const seam = await this.planFor(key, nearby);
    await this.auditionSpan(key, { start: nearby.start, end: nearby.end, ...(seam ? { seam } : {}) });
  }

  /** Move the loop to the nearby loop (bigger than a beat, so it only happens when the user clicks). */
  useNearby(id: string): void {
    const nearby = this.nearbyOf(id);
    if (!nearby) return;
    this.updateRegion(id, { start: nearby.start, end: nearby.end });
  }

  /** The Bridge toggle of a loop (SPEC-seams.md 5; off by default). */
  setBridge(id: string, on: boolean): void {
    this.updateRegion(id, { bridge: on });
  }

  /** Undo (SPEC-seams.md 3.5): the loop plays exactly as its points say, and smoothing stays off for it. */
  undoSeam(id: string): void {
    const { regions } = this.store.get();
    if (!regions.some((r) => r.id === id)) return;
    this.seamKeys.delete(id);
    this.commitRegions(regions.map((r) => (r.id === id ? undoSmoothing(r) : r)));
    // the chip goes back to the raw seam
    this.scheduleSeamReports();
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

  // ---- cuts (SPEC-v1.3.md 2) -----------------------------------------------------

  /** Set the cuts (kept in song order); target-length mode re-solves the repeats for the shorter song. */
  private commitCuts(cuts: Cut[], extra: Partial<AppState> = {}): void {
    this.commitRegions(this.store.get().regions, { ...extra, cuts: sortCuts(cuts) });
  }

  /** The length of a cut that has no span of its own: one bar, or 2 s without a steady beat. */
  private defaultCutSeconds(): number {
    const { grid, song } = this.store.get();
    const duration = song?.duration ?? 2;
    return Math.min(grid.steady ? grid.barSeconds : 2, duration / 2);
  }

  /**
   * X and Cut selection: take the waveform selection out of the extended song. With no selection, a short cut (one bar)
   * opens at the playhead, or in the free song after it when the playhead is in a loop or a cut, to be set with the time
   * fields. A selection that overlaps a loop or a cut is refused, with the reason.
   */
  cutSelection(): string | null {
    const { song, selection, grid } = this.store.get();
    if (!song) return null;
    let want = selection;
    if (!want) {
      const at = this.originalPlayhead();
      const len = this.defaultCutSeconds();
      const gaps = freeGaps(this.obstacles(), song.duration).filter((g) => g.end - g.start >= MIN_CUT_SECONDS);
      const gap = gaps.find((g) => g.end > at + MIN_CUT_SECONDS) ?? gaps[gaps.length - 1];
      if (!gap) {
        this.notify('There is no free span of the song left to cut.');
        return null;
      }
      const from = Math.max(gap.start, grid.steady ? snapTime(grid, at, true) : at);
      const start = Math.max(gap.start, Math.min(from, gap.end - Math.min(len, gap.end - gap.start)));
      want = { start: roundMs(start), end: roundMs(Math.min(gap.end, start + len)) };
    }
    return this.addCut(want);
  }

  addCut(span: Span): string | null {
    const { song, cuts } = this.store.get();
    if (!song) return null;
    const start = Math.max(0, span.start);
    const end = Math.min(song.duration, span.end);
    const refused = this.checkCutPoints('', start, end, 'end');
    if (refused) {
      this.notify(refused);
      return null;
    }
    const id = newCutId();
    this.commitCuts([...cuts, { id, start, end }], { selectedId: id, selection: null });
    return id;
  }

  /** Why a cut with these points is not allowed, or null (same rules and wording as loops; 50 ms at least). */
  private checkCutPoints(id: string, start: number, end: number, edge: Edge): string | null {
    const { song, regions, cuts } = this.store.get();
    if (!song) return 'Load a song first.';
    return checkSpanPoints({ what: 'cut', id, start, end, edge, duration: song.duration, regions, cuts });
  }

  /** A cut's edges moved by dragging (snapped to bars unless Shift is held). Refused when it would overlap. */
  private updateCut(id: string, patch: Partial<Cut>): void {
    const { song, cuts } = this.store.get();
    if (!song) return;
    const current = cuts.find((c) => c.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    const fit = fitSpan(this.obstacles(), { start: next.start, end: next.end }, song.duration, MIN_CUT_SECONDS, id);
    if (!fit) {
      this.commitCuts([...cuts]);
      this.notify('Cuts cannot overlap loops or other cuts. The edit was refused.');
      return;
    }
    this.commitCuts(cuts.map((c) => (c.id === id ? { ...next, start: fit.start, end: fit.end } : c)));
  }

  /** Move a cut's start or end to an exact time (typed, nudged, from the playhead): exact, never snapped, refused when not allowed. */
  editCutEdge(id: string, edge: Edge, edit: EdgeEdit): string | null {
    const { song, cuts } = this.store.get();
    if (!song) return 'Load a song first.';
    const cut = cuts.find((c) => c.id === id);
    if (!cut) return 'That cut is gone.';
    const current = cut[edge];
    let value: number;
    if (edit.type === 'time') value = edit.seconds;
    else if (edit.type === 'ms') value = current + edit.delta;
    else if (edit.type === 'beat') {
      const len = this.beatLengthAt(current, edit.dir);
      if (len === null) return 'There is no steady beat to nudge by.';
      value = current + edit.dir * len;
    } else value = this.originalPlayhead();
    value = roundMs(value);
    const start = edge === 'start' ? value : cut.start;
    const end = edge === 'end' ? value : cut.end;
    const refused = this.checkCutPoints(id, start, end, edge);
    if (refused) return refused;
    if (Math.round(value * 1000) === Math.round(current * 1000)) return null;
    this.commitCuts(cuts.map((c) => (c.id === id ? { ...c, start, end } : c)));
    return null;
  }

  removeCut(id: string): void {
    const { cuts, selectedId } = this.store.get();
    this.commitCuts(
      cuts.filter((c) => c.id !== id),
      { selectedId: selectedId === id ? null : selectedId },
    );
  }

  // ---- zoom --------------------------------------------------------------------

  private setZoom(v: number): void {
    // Slider 0 = fit; otherwise log scale 10..400 px per second.
    this.applyZoom(v <= 0 ? 0 : Math.round(ZOOM_MIN_PX * Math.pow(ZOOM_MAX_PX / ZOOM_MIN_PX, v / 100)));
  }

  /** Zoom to an exact number of pixels per second (0 fits the song), as typed in the field. */
  private setZoomPx(px: number): void {
    this.applyZoom(px);
  }

  private applyZoom(px: number): void {
    this.store.set({ zoom: px });
    this.waveform?.setZoom(px);
    this.zoomField.setValue(px);
    this.zoomSlider.value = String(px <= 0 ? 0 : Math.round((100 * Math.log(px / ZOOM_MIN_PX)) / Math.log(ZOOM_MAX_PX / ZOOM_MIN_PX)));
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
      const ok = await this.ensureExtendedStream();
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
      this.extendedKey = null;
      this.store.set({ playMode: 'original' });
      this.player.setBuffer(song.buffer);
      this.player.seek(orig);
      if (wasPlaying) await this.player.play();
    } else {
      const origT = t;
      this.store.set({ playMode: 'extended' });
      this.extendedKey = null;
      const ok = await this.ensureExtendedStream(false);
      if (!ok) return;
      this.player.seek(originalToExtended(this.timeline, origT));
      if (wasPlaying) await this.player.play();
    }
    this.renderTime();
  }

  private scheduleRender(): void {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => void this.ensureExtendedStream(true), RENDER_CONFIG.renderDebounceMs);
  }

  /**
   * Point the player at the extended song of the current plan. It is not rendered up front: the render worker makes
   * the next few seconds of it (`renderRange`, the same code as the export) while it plays, so any length works.
   * After a change to the plan, `keepPosition` (the default) carries on from the same place in the new cut.
   */
  private async ensureExtendedStream(keepPosition = true): Promise<boolean> {
    const { song, seamMs } = this.store.get();
    if (!song) return false;
    const plan = this.plan();
    const key = planKey(plan, song.duration, seamMs);
    if (this.extendedKey === key) return true;
    try {
      const frames = this.plannedFrames();
      const source = new WorkerChunkSource(this.renderClient, plan, seamMs, frames, song.sampleRate, song.channels);
      this.extendedKey = key;
      this.timeline = buildTimeline(plan, song.duration);
      this.player.setStream(source, keepPosition);
      this.store.set({ renderState: 'ready' });
      return true;
    } catch (err) {
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
    if (!region) return;
    await this.seamsSettled();
    const now = this.store.get().regions.find((r) => r.id === id);
    if (now) await this.previewSpan(id, now, true);
  }

  /** Hear the jump back to the loop's start, smoothed as the export will have it, or with `original` as the raw seam. */
  async auditionSeam(id: string, original = false): Promise<void> {
    const region = this.store.get().regions.find((r) => r.id === id);
    if (!region) return;
    await this.seamsSettled();
    const now = this.store.get().regions.find((r) => r.id === id);
    if (!now) return;
    // the raw seam: the user's own points with the global crossfade, no smoothing and no bridge
    await this.auditionSpan(id, original ? { start: now.start, end: now.end } : now);
  }

  async previewCandidate(index: number): Promise<void> {
    const c = this.store.get().analysis?.candidates[index];
    if (!c) return;
    const key = suggestionKey(index);
    if (this.store.get().previewingId === key) return this.previewSpan(key, c, false);
    const seam = await this.planFor(key, c);
    await this.previewSpan(key, { start: c.start, end: c.end, ...(seam ? { seam } : {}) }, false);
  }

  async auditionCandidate(index: number): Promise<void> {
    const c = this.store.get().analysis?.candidates[index];
    if (!c) return;
    const key = suggestionKey(index);
    const seam = await this.planFor(key, c);
    await this.auditionSpan(key, { start: c.start, end: c.end, ...(seam ? { seam } : {}) });
  }

  addCandidate(index: number): void {
    const c = this.store.get().analysis?.candidates[index];
    if (!c) return;
    this.addLoop({ start: c.start, end: c.end }, { score: c.score });
  }

  /** Hear a span looping, rendered exactly as the export would (same seam, bridge and crossfade). Toggles. */
  private async previewSpan(key: string, span: PreviewRegion, select: boolean): Promise<void> {
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
    this.aux = { kind: 'loop', map: body.map, sampleRate: body.sampleRate, period: dur };
    this.store.set(select ? { previewingId: key, selectedId: key } : { previewingId: key });
    await this.player.playAux(body, { loopStart: 0, loopEnd: dur, offset: 0 });
    if (this.aux?.kind === 'loop' && this.store.get().previewingId === key) this.stopAux();
  }

  /** Hear the jump from the span's end back to its start. */
  private async auditionSpan(key: string, span: PreviewRegion): Promise<void> {
    await this.playSnippet(key, (buffer, crossfadeMs) => renderSeamSnippet(buffer, span, { crossfadeMs }));
  }

  /** Hear a cut: 4 s before the join through 4 s after it, as the extended song has it (SPEC-v1.3.md 2.2). */
  async auditionCut(id: string): Promise<void> {
    const cut = this.store.get().cuts.find((c) => c.id === id);
    if (!cut) return;
    await this.playSnippet(id, (buffer, crossfadeMs) => renderCutSnippet(buffer, cut, { crossfadeMs }));
  }

  /** Play a short snippet of the song (seam or cut audition) in place of the main playback. */
  private async playSnippet(
    key: string,
    make: (buffer: DecodedSong['buffer'], crossfadeMs: number) => ReturnType<typeof renderSeamSnippet>,
  ): Promise<void> {
    const { song, seamMs } = this.store.get();
    if (!song) return;
    this.stopAux();
    this.player.pause();
    let snip: ReturnType<typeof renderSeamSnippet>;
    try {
      snip = make(song.buffer, seamMs);
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err));
      return;
    }
    this.aux = { kind: 'seam', map: snip.map, sampleRate: snip.sampleRate };
    const { regions, cuts } = this.store.get();
    if (regions.some((r) => r.id === key) || cuts.some((c) => c.id === key)) this.store.set({ selectedId: key });
    await this.player.playAux(snip);
    this.aux = null;
    this.renderTime();
  }

  // ---- export ------------------------------------------------------------------

  private openExport(): void {
    const { song, speed, pitch, bitDepth } = this.store.get();
    if (!song) return;
    const exactFrames = this.plannedFrames();
    const blocked = this.tooLongFor(16, exactFrames);
    if (blocked) {
      this.notify(blocked);
      return;
    }
    const neutral = isNeutral({ tempo: speed, pitchSemitones: pitch });
    const base = song.name.replace(/\.[^./\\]+$/, '');
    const framesOf = (bake: boolean): number => (bake ? exportFrames(exactFrames, { tempo: speed, pitchSemitones: pitch }) : exactFrames);
    this.exportTarget = { kind: 'song' };
    this.exportDialog.open({
      defaultName: `${base} (extended).wav`,
      bitDepth,
      speedPitchNeutral: neutral,
      speedPitchLabel: this.speedPitchLabel(),
      format: `${formatRate(song.sampleRate)} ${formatChannels(song.channels)}`,
      estimate: (depth, bake) => {
        const frames = framesOf(bake);
        return { bytes: estimateWavSize(frames, song.channels, depth), seconds: frames / song.sampleRate };
      },
      problem: (depth, bake) => wavTooLong(framesOf(bake), song.sampleRate, song.channels, depth),
    });
  }

  /** "1.10x speed, +2 semitones": what Apply speed and pitch changes would put into the file. */
  private speedPitchLabel(): string {
    const { speed, pitch } = this.store.get();
    const parts: string[] = [];
    if (Math.abs(speed - 1) > 1e-6) parts.push(`${speed.toFixed(2)}x speed`);
    if (pitch !== 0) parts.push(`${pitch > 0 ? '+' : ''}${pitch} semitone${Math.abs(pitch) === 1 ? '' : 's'}`);
    return parts.join(', ');
  }

  /**
   * Export loop (SPEC-v1.3.md 7.1): the export dialog for one loop's own audio file. Its seam plan is settled first, so the
   * file holds what the loop sounds like; the size and the WAV cap check follow the repeats typed in the dialog.
   */
  async openExportLoop(id: string): Promise<void> {
    if (!this.store.get().regions.some((r) => r.id === id)) return;
    await this.seamsSettled();
    const { song, regions, speed, pitch, bitDepth } = this.store.get();
    const region = regions.find((r) => r.id === id);
    if (!song || !region) return;
    let layout: ReturnType<typeof loopFileLayout>;
    try {
      layout = loopFileLayout(song.buffer, region);
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err));
      return;
    }
    const stretch = { tempo: speed, pitchSemitones: pitch };
    const framesOf = (repeats: number, bake: boolean): number => (bake ? exportFrames(layout.frames(repeats), stretch) : layout.frames(repeats));
    this.exportTarget = { kind: 'loop', id };
    this.exportDialog.open({
      defaultName: loopFileName(song.name, regions.indexOf(region) + 1, region.start, region.end),
      bitDepth,
      speedPitchNeutral: isNeutral(stretch),
      speedPitchLabel: this.speedPitchLabel(),
      format: `${formatRate(song.sampleRate)} ${formatChannels(song.channels)}`,
      estimate: (depth, bake, repeats) => {
        const frames = framesOf(repeats, bake);
        return { bytes: estimateWavSize(frames, song.channels, depth), seconds: frames / song.sampleRate };
      },
      problem: (depth, bake, repeats) => wavTooLong(framesOf(repeats, bake), song.sampleRate, song.channels, depth),
      loop: { bridgeOn: region.bridge === true },
    });
  }

  private async doExport(opts: ExportOptions): Promise<void> {
    const target = this.exportTarget;
    const label = opts.applySpeedPitch ? 'Rendering, applying speed and pitch, and writing the WAV' : 'Rendering and writing the WAV';
    this.exportDialog.setProgress(`${label}\u2026`, 0);
    // what the export plays is what the preview played: every loop's seam plan is in first
    await this.seamsSettled();
    const { seamMs, speed, pitch, regions } = this.store.get();
    const stretch = opts.applySpeedPitch ? { tempo: speed, pitchSemitones: pitch } : null;
    // one loop as a file of its own: a plan with just that loop, played `repeats` times, optionally loop-ready
    let plan = this.plan();
    let loopFile: { loopReady: boolean } | undefined;
    if (target.kind === 'loop') {
      const region = regions.find((r) => r.id === target.id);
      if (!region) throw new Error('That loop is gone.');
      plan = loopFilePlan(region, opts.repeats ?? 1);
      loopFile = { loopReady: opts.loopReady !== false };
    }
    const started = performance.now();
    try {
      const { blob } = await this.renderClient.export(
        plan,
        { crossfadeMs: seamMs, bitDepth: opts.bitDepth, stretch, ...(loopFile ? { loopFile } : {}) },
        ({ fraction }) => {
          const elapsed = (performance.now() - started) / 1000;
          const left = fraction > 0.02 ? (elapsed * (1 - fraction)) / fraction : null;
          this.exportDialog.setProgress(
            `${label}\u2026 ${Math.floor(fraction * 100)}% \u00b7 ${formatTime(elapsed)} elapsed${left !== null ? ` \u00b7 about ${formatTime(left)} left` : ''}`,
            fraction,
          );
        },
      );
      this.exportDialog.setProgress('Saving\u2026', 1);
      await saveWav(blob, opts.filename);
    } catch (err) {
      if (err instanceof ExportCancelledError) this.exportDialog.setProgress('Export cancelled.', null);
      throw err;
    }
  }

  // ---- test support ------------------------------------------------------------

  /**
   * For the end-to-end tests: run the live preview's scheduler (`ChunkStream` over the render worker's chunks) on an
   * OfflineAudioContext for `seconds` of the extended song from `fromSeconds`, and compare what it plays with the same
   * span rendered in one piece (`renderRange`). With the context at the song's sample rate and rate 1 the two must be
   * identical, sample for sample (no gap, no overlap, at any join). With another context rate, both go through the
   * browser's resampler (the scheduler's chunks, and one source node holding the whole span) and are compared.
   */
  async captureExtendedPreview(opts: { fromSeconds: number; seconds: number; contextRate?: number }): Promise<{
    frames: number;
    /** Largest difference anywhere, and within 200 samples of a chunk join, and where the first difference is (-1: none). */
    maxDifference: number;
    joinDifference: number;
    firstDifferent: number;
    peak: number;
    joins: number;
  }> {
    const { song, seamMs } = this.store.get();
    if (!song) throw new Error('Load a song first.');
    const plan = this.plan();
    const sr = song.sampleRate;
    const source = new WorkerChunkSource(this.renderClient, plan, seamMs, this.plannedFrames(), sr, song.channels);
    const rate = opts.contextRate ?? sr;
    const length = Math.round(opts.seconds * rate);
    const from = Math.round(opts.fromSeconds * sr);
    const frames = Math.round(opts.seconds * sr);
    const render = async (fill: (ctx: OfflineAudioContext) => Promise<void>): Promise<Float32Array[]> => {
      const ctx = new OfflineAudioContext(song.channels, length, rate);
      await fill(ctx);
      const out = await ctx.startRendering();
      return Array.from({ length: song.channels }, (_, c) => out.getChannelData(c).slice());
    };
    const played = await render(async (ctx) => {
      const stream = new ChunkStream(ctx, ctx.destination, source);
      await stream.start(from, 1, 0);
      await stream.fill(opts.seconds);
    });
    const whole = await this.renderClient.renderChunk(plan, seamMs, from, frames);
    const reference = await render(async (ctx) => {
      const buffer = ctx.createBuffer(whole.length, frames, sr);
      whole.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.start(0);
    });
    // where the chunk joins fall in the capture
    const chunkFrames = Math.round(STREAM_DEFAULTS.chunkSeconds * sr);
    const joins: number[] = [];
    for (let at = (Math.floor(from / chunkFrames) + 1) * chunkFrames; at < from + frames; at += chunkFrames) {
      joins.push(Math.round(((at - from) / sr) * rate));
    }
    let maxDifference = 0;
    let joinDifference = 0;
    let firstDifferent = -1;
    let peak = 0;
    for (let c = 0; c < played.length; c++) {
      for (let i = 0; i < length; i++) {
        const d = Math.abs(played[c]![i]! - reference[c]![i]!);
        if (d > maxDifference) maxDifference = d;
        if (d > 0 && firstDifferent < 0) firstDifferent = i;
        peak = Math.max(peak, Math.abs(played[c]![i]!));
      }
      for (const j of joins) {
        for (let i = Math.max(0, j - 200); i < Math.min(length, j + 200); i++) {
          joinDifference = Math.max(joinDifference, Math.abs(played[c]![i]! - reference[c]![i]!));
        }
      }
    }
    return { frames: length, maxDifference, joinDifference, firstDifferent, peak, joins: joins.length };
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

  /** Seconds since the last analysed beat at or before original-song time `t`; Infinity without a steady beat. */
  private beatPhase(t: number): number {
    const { grid } = this.store.get();
    const beats = grid.beats;
    if (!grid.steady || beats.length < 2 || t < beats[0]!) return Infinity;
    let lo = 0;
    let hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    const phase = t - beats[lo]!;
    // after the last beat there is nothing to pulse on
    return lo === beats.length - 1 && phase > grid.beatSeconds ? Infinity : phase;
  }

  private beatOn = false;

  /**
   * The Night club skin's signature motion: the play ring and the played part of the waveform pulse briefly on each beat.
   * It follows the playhead over the analysed beat grid (in original-song time, so it works for the extended song and the
   * previews too) and only switches the class `beat`; there is nothing without a steady beat, and nothing with
   * prefers-reduced-motion.
   */
  private pulseOnBeat(orig: number): void {
    const club = document.documentElement.dataset.skin === 'club';
    const playing = this.player.isPlaying() || this.player.isAuxPlaying();
    const on = club && playing && !matchMedia('(prefers-reduced-motion: reduce)').matches && this.beatPhase(orig) < BEAT_PULSE_SECONDS;
    if (on === this.beatOn) return;
    this.beatOn = on;
    this.transport.setBeat(on);
    this.waveHost.classList.toggle('beat', on);
  }

  private renderTime(): void {
    const { song, playMode } = this.store.get();
    if (!song) return;
    if (this.player.isAuxPlaying() && this.aux) {
      const orig = this.originalPlayhead();
      this.pulseOnBeat(orig);
      this.transport.setTime(orig, song.duration);
      this.waveform?.setCursor(orig, true);
      this.timelineStrip.setPosition(originalToExtended(this.timeline, orig));
      return;
    }
    const t = this.player.getTime();
    this.transport.setTime(t, this.player.duration);
    const orig = playMode === 'extended' ? extendedToOriginal(this.timeline, t).time : t;
    this.pulseOnBeat(orig);
    this.waveform?.setCursor(orig, this.player.isPlaying());
    this.timelineStrip.setPosition(playMode === 'extended' ? t : originalToExtended(this.timeline, t));
  }
}
