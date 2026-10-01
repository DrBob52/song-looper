import { formatChannels, formatRate } from '../util/format';
import { formatTime } from '../util/time';
import { clear, h } from './dom';

export interface FileInfo {
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
}

/** Drop zone, file summary and analysis progress bar. */
export class Dropzone {
  readonly el: HTMLElement;
  private zone: HTMLElement;
  private input: HTMLInputElement;
  private progress: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  private banner: HTMLElement;
  private warning: HTMLElement;

  constructor(private onFile: (file: File) => void) {
    this.input = h('input', {
      attrs: {
        type: 'file',
        accept: 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus',
        hidden: true,
        'aria-label': 'Choose an audio file',
        'data-testid': 'file-input',
      },
      on: {
        change: () => {
          const f = this.input.files?.[0];
          if (f) this.onFile(f);
          this.input.value = '';
        },
      },
    });
    this.zone = h('div', {
      class: 'dropzone',
      attrs: { role: 'button', tabindex: 0, 'aria-label': 'Drop a song here or click to choose', 'data-testid': 'dropzone' },
      on: {
        click: () => this.input.click(),
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.input.click();
          }
        },
        dragenter: (e) => {
          e.preventDefault();
          this.zone.classList.add('drag');
        },
        dragover: (e) => {
          e.preventDefault();
          this.zone.classList.add('drag');
        },
        dragleave: () => this.zone.classList.remove('drag'),
        drop: (e) => {
          e.preventDefault();
          this.zone.classList.remove('drag');
          const f = e.dataTransfer?.files?.[0];
          if (f) this.onFile(f);
        },
      },
    });
    this.fill = h('div', { class: 'fill' });
    this.label = h('div', { class: 'label' });
    this.progress = h('div', { class: 'progress', attrs: { hidden: true, 'data-testid': 'progress' } }, [
      h('div', { class: 'track' }, [this.fill]),
      this.label,
    ]);
    this.banner = h('div', { class: 'banner error', attrs: { role: 'alert', hidden: true, 'data-testid': 'error' } });
    this.warning = h('div', { class: 'banner warn', attrs: { role: 'status', hidden: true, 'data-testid': 'warning' } });
    this.el = h('section', { attrs: { 'aria-label': 'Load a song' } }, [this.zone, this.input, this.progress, this.banner, this.warning]);
    this.showEmpty();
  }

  /** The sleeve is a face with the song on it and a record sliding out of its edge (drawn in CSS). */
  private sleeve(children: HTMLElement[]): void {
    clear(this.zone);
    this.zone.append(h('span', { class: 'sleeve-record', attrs: { 'aria-hidden': 'true' } }), h('div', { class: 'sleeve-face' }, children));
  }

  private showEmpty(): void {
    this.zone.classList.remove('compact');
    this.sleeve([
      h('div', { class: 'dz-title', text: 'Drop a song here or click to choose' }),
      h('div', {
        class: 'dz-sub',
        text: 'mp3, wav, m4a, flac or ogg. Everything stays in your browser; nothing is uploaded.',
      }),
    ]);
  }

  showFile(info: FileInfo): void {
    this.zone.classList.add('compact');
    this.sleeve([
      h('div', { class: 'dz-title', text: info.name, attrs: { 'data-testid': 'file-name' } }),
      h('div', {
        class: 'dz-sub mono',
        text: `${formatTime(info.duration)} · ${formatRate(info.sampleRate)} · ${formatChannels(info.channels)}`,
        attrs: { 'data-testid': 'file-meta' },
      }),
      h('div', { class: 'dz-sub', text: 'Drop or click to choose another song' }),
    ]);
  }

  clearFile(): void {
    this.showEmpty();
    this.hideProgress();
  }

  setBusy(busy: boolean): void {
    this.zone.classList.toggle('busy', busy);
  }

  showProgress(message: string, pct: number | null): void {
    this.progress.hidden = false;
    this.label.textContent = message;
    this.fill.style.width = pct === null ? '100%' : `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`;
    this.fill.style.opacity = pct === null ? '0.35' : '1';
  }

  hideProgress(): void {
    this.progress.hidden = true;
  }

  showWarning(message: string | null): void {
    this.warning.hidden = !message;
    this.warning.textContent = message ?? '';
  }

  showError(message: string | null): void {
    this.banner.hidden = !message;
    this.banner.textContent = message ?? '';
  }
}
