import { computePeaks, decodeFile } from './audio/decode';
import type { DecodedSong } from './audio/decode';
import { Player } from './audio/player';
import { createStore } from './util/store';
import { Dropzone } from './ui/dropzone';
import { h } from './ui/dom';
import { Transport } from './ui/transport';
import { WaveformView } from './ui/waveform';
import type { Span } from './model';

export interface AppState {
  song: DecodedSong | null;
  selection: Span | null;
  zoom: number;
}

export class App {
  readonly store = createStore<AppState>({ song: null, selection: null, zoom: 0 });
  readonly player = new Player();
  private dropzone: Dropzone;
  private transport: Transport;
  private songPanel: HTMLElement;
  private waveHost: HTMLElement;
  private waveform: WaveformView | null = null;
  private raf = 0;
  private loadToken = 0;

  constructor(private root: HTMLElement) {
    this.dropzone = new Dropzone((f) => void this.loadFile(f));
    this.transport = new Transport({ onTogglePlay: () => this.togglePlay() });
    this.transport.setEnabled(false);
    this.waveHost = h('div', { class: 'wave-host', attrs: { 'data-testid': 'waveform' } });

    const zoom = h('input', {
      attrs: { type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Zoom', 'data-testid': 'zoom' },
      on: {
        input: (e) => {
          const v = Number((e.target as HTMLInputElement).value);
          this.setZoom(v);
        },
      },
    });
    const toolbar = h('div', { class: 'wave-toolbar' }, [
      h('label', { class: 'field grow' }, [h('span', { text: 'Zoom' }), zoom]),
    ]);
    this.songPanel = h('div', { attrs: { hidden: true, 'data-testid': 'song-panel' }, style: { display: 'grid', gap: '14px' } }, [
      h('section', { class: 'card', attrs: { 'aria-label': 'Waveform' } }, [
        toolbar,
        this.waveHost,
        h('div', { class: 'wave-hint' }, [
          'Click to seek. ',
          h('kbd', { text: 'Space' }),
          ' play/pause.',
        ]),
      ]),
    ]);

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
    );

    this.player.subscribe((ev) => {
      this.transport.setPlaying(this.player.isPlaying());
      if (ev === 'play') this.startTicker();
      this.renderTime();
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private setZoom(v: number): void {
    // Slider 0 = fit; otherwise log scale 10..400 px per second.
    const px = v <= 0 ? 0 : Math.round(10 * Math.pow(40, v / 100));
    this.store.set({ zoom: px });
    this.waveform?.setZoom(px);
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    if (e.code === 'Space' && !typing && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      this.togglePlay();
    }
  }

  togglePlay(): void {
    if (!this.store.get().song) return;
    this.player.toggle();
  }

  async loadFile(file: File): Promise<void> {
    const token = ++this.loadToken;
    this.player.stop();
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

  private openSong(song: DecodedSong): void {
    this.waveform?.destroy();
    this.waveform = null;
    this.store.set({ song, selection: null });
    this.dropzone.showFile(song);
    this.songPanel.hidden = false;
    this.player.setBuffer(song.buffer);
    this.transport.setEnabled(true);

    const peaks = computePeaks(song.buffer, 100);
    this.waveform = new WaveformView(this.waveHost, peaks, song.duration, {
      onSeek: (t) => {
        this.player.seek(t);
        this.renderTime();
      },
      onSelection: (sel) => this.store.set({ selection: sel }),
      onRegionEdit: () => undefined,
      onRegionSelect: () => undefined,
      getSnap: () => null,
      getBounds: () => null,
      getMinLength: () => 0.1,
    });
    this.waveform.setZoom(this.store.get().zoom);
    this.renderTime();
  }

  private startTicker(): void {
    cancelAnimationFrame(this.raf);
    const tick = (): void => {
      this.renderTime();
      if (this.player.isPlaying()) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private renderTime(): void {
    const t = this.player.getTime();
    this.transport.setTime(t, this.player.duration);
    this.waveform?.setCursor(t, this.player.isPlaying());
  }
}
