import { RENDER_CONFIG } from '../audio/config';
import type { BitDepth } from '../audio/wav';
import { formatTime } from '../util/time';
import { clear, h } from './dom';

/** The thrown error that means the user cancelled the export (not a failure). */
export const EXPORT_CANCELLED = 'ExportCancelledError';

export interface ExportOptions {
  filename: string;
  bitDepth: BitDepth;
  applySpeedPitch: boolean;
}

export interface ExportInfo {
  defaultName: string;
  /** The bit depth to start with (the one chosen last). */
  bitDepth: BitDepth;
  /** Size and duration of the file for the given settings. */
  estimate(bitDepth: BitDepth, applySpeedPitch: boolean): { bytes: number; seconds: number };
  /** Why a file with these settings cannot be written (it would not fit in a WAV), or null. */
  problem(bitDepth: BitDepth, applySpeedPitch: boolean): string | null;
  speedPitchNeutral: boolean;
  /** e.g. "1.10x speed, +2 semitones" */
  speedPitchLabel: string;
  /** e.g. "44.1 kHz stereo" */
  format: string;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function sanitizeFilename(name: string): string {
  let n = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  if (!n) n = 'extended';
  if (!/\.wav$/i.test(n)) n += '.wav';
  return n;
}

/** Export dialog: bit depth, optional speed/pitch baking, file name, progress. */
export class ExportDialog {
  readonly el: HTMLDialogElement;
  private info: ExportInfo | null = null;
  private nameInput: HTMLInputElement;
  private bake: HTMLInputElement;
  private bakeHelp: HTMLElement;
  private depthInputs: HTMLInputElement[] = [];
  private estimateEl: HTMLElement;
  private warnEl: HTMLElement;
  private problemEl: HTMLElement;
  private statusEl: HTMLElement;
  private errorEl: HTMLElement;
  private depthLabels: HTMLElement[] = [];
  private progress: HTMLElement;
  private fill: HTMLElement;
  private progressLabel: HTMLElement;
  private exportBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private busy = false;

  constructor(
    private cb: {
      onExport(opts: ExportOptions): void | Promise<void>;
      /** The dialog was closed without exporting. */
      onCancel(): void;
      /** Stop the export that is running. */
      onCancelExport(): void;
      /** The user picked another bit depth. */
      onDepth(depth: BitDepth): void;
    },
  ) {
    this.nameInput = h('input', { attrs: { type: 'text', 'aria-label': 'File name', 'data-testid': 'export-name' }, class: 'grow' });
    this.bake = h('input', {
      attrs: { type: 'checkbox', 'data-testid': 'export-bake' },
      on: { change: () => this.refresh() },
    });
    this.bakeHelp = h('div', { class: 'muted small' });
    const depths: [BitDepth, string][] = [
      [16, '16-bit PCM (default)'],
      [24, '24-bit PCM'],
      [32, '32-bit float'],
    ];
    const depthRow = h('div', { class: 'col' });
    for (const [depth, label] of depths) {
      const input = h('input', {
        attrs: { type: 'radio', name: 'bitdepth', value: depth, 'data-testid': `depth-${depth}` },
        on: {
          change: () => {
            this.cb.onDepth(this.selectedDepth());
            this.refresh();
          },
        },
      });
      input.checked = depth === 16;
      this.depthInputs.push(input);
      const note = h('span', { class: 'depth-note small', attrs: { hidden: true } });
      this.depthLabels.push(note);
      depthRow.append(h('label', { class: 'field' }, [input, h('span', { text: label }), note]));
    }
    this.estimateEl = h('div', { class: 'mono small', attrs: { 'data-testid': 'export-estimate' } });
    this.warnEl = h('div', { class: 'banner warn', attrs: { hidden: true, 'data-testid': 'export-warning' } });
    this.problemEl = h('div', { class: 'banner error', attrs: { hidden: true, role: 'alert', 'data-testid': 'export-problem' } });
    this.statusEl = h('div', { class: 'banner', attrs: { hidden: true, role: 'status', 'data-testid': 'export-status' } });
    this.errorEl = h('div', { class: 'banner error', attrs: { hidden: true, role: 'alert', 'data-testid': 'export-error' } });
    this.fill = h('div', { class: 'fill' });
    this.progressLabel = h('div', { class: 'label' });
    this.progress = h('div', { class: 'progress', attrs: { hidden: true, 'data-testid': 'export-progress' } }, [
      h('div', { class: 'track' }, [this.fill]),
      this.progressLabel,
    ]);
    this.exportBtn = h('button', {
      class: 'btn primary',
      text: 'Export',
      attrs: { type: 'submit', 'data-testid': 'export-confirm' },
    });
    this.cancelBtn = h('button', {
      class: 'btn',
      text: 'Cancel',
      attrs: { type: 'button', 'data-testid': 'export-cancel' },
      on: {
        click: () => {
          // while exporting, Cancel stops the export; otherwise it closes the dialog
          if (this.busy) this.cb.onCancelExport();
          else this.requestClose();
        },
      },
    });
    const form = h(
      'form',
      {
        class: 'export-form',
        on: {
          submit: (e) => {
            e.preventDefault();
            void this.submit();
          },
        },
      },
      [
        h('h2', { text: 'Export WAV' }),
        h('label', { class: 'field' }, [h('span', { text: 'File name' }), this.nameInput]),
        h('fieldset', {}, [h('legend', { text: 'Bit depth' }), depthRow]),
        h('div', {}, [
          h('label', { class: 'field' }, [this.bake, h('span', { text: 'Apply speed and pitch changes' })]),
          this.bakeHelp,
        ]),
        this.estimateEl,
        this.warnEl,
        this.problemEl,
        this.statusEl,
        this.errorEl,
        this.progress,
        h('div', { class: 'row actions' }, [h('span', { class: 'grow' }), this.cancelBtn, this.exportBtn]),
      ],
    );
    this.el = h('dialog', { class: 'export-dialog', attrs: { 'aria-label': 'Export WAV', 'data-testid': 'export-dialog' } }, [form]);
    this.el.addEventListener('cancel', (e) => {
      if (this.busy) e.preventDefault();
    });
    this.el.addEventListener('close', () => this.setBusy(false));
  }

  open(info: ExportInfo): void {
    this.info = info;
    this.nameInput.value = info.defaultName;
    this.bake.checked = false;
    this.bake.disabled = info.speedPitchNeutral;
    this.bakeHelp.textContent = info.speedPitchNeutral
      ? 'Speed and pitch are at their neutral settings, so there is nothing to apply.'
      : `Off: the file is the original sound. On: render ${info.speedPitchLabel} into the file.`;
    this.errorEl.hidden = true;
    this.statusEl.hidden = true;
    this.progress.hidden = true;
    this.setBusy(false);
    this.depthInputs.forEach((i) => (i.checked = Number(i.value) === info.bitDepth));
    this.refresh();
    if (!this.el.open) this.el.showModal();
    this.nameInput.focus();
    this.nameInput.select();
  }

  private selectedDepth(): BitDepth {
    const checked = this.depthInputs.find((i) => i.checked);
    return (Number(checked?.value ?? 16) as BitDepth) || 16;
  }

  private refresh(): void {
    if (!this.info) return;
    const est = this.info.estimate(this.selectedDepth(), this.bake.checked && !this.bake.disabled);
    this.estimateEl.textContent = `About ${formatBytes(est.bytes)} · ${formatTime(est.seconds)} · ${this.info.format}`;
    const bake = this.bake.checked && !this.bake.disabled;
    const problem = this.info.problem(this.selectedDepth(), bake);
    this.problemEl.hidden = !problem;
    this.problemEl.textContent = problem ?? '';
    this.exportBtn.disabled = this.busy || problem !== null;
    // say which depths the song is too long for, so the choice is clear before it is made
    this.depthInputs.forEach((input, i) => {
      const tooLong = this.info!.problem(Number(input.value) as BitDepth, bake) !== null;
      this.depthLabels[i]!.hidden = !tooLong;
      this.depthLabels[i]!.textContent = tooLong ? '(too long)' : '';
    });
    const big = !problem && est.bytes > RENDER_CONFIG.largeFileBytes;
    this.warnEl.hidden = !big;
    if (big) {
      this.warnEl.textContent = `This file will be large (${formatBytes(est.bytes)}). It is rendered and written piece by piece, so it needs little memory, but it takes a while. 16-bit or a shorter length makes it smaller.`;
    }
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    this.errorEl.hidden = true;
    // Read the options before busy-mode disables the form controls.
    const options: ExportOptions = {
      filename: sanitizeFilename(this.nameInput.value),
      bitDepth: this.selectedDepth(),
      applySpeedPitch: this.bake.checked && !this.bake.disabled,
    };
    this.setBusy(true);
    try {
      await this.cb.onExport(options);
      this.el.close();
    } catch (err) {
      if (err instanceof Error && err.name === EXPORT_CANCELLED) {
        this.setBusy(false);
        this.statusEl.hidden = false;
        this.statusEl.textContent = 'Export cancelled. Nothing was saved.';
        return;
      }
      this.showError(err instanceof Error ? err.message : String(err));
      this.setBusy(false);
    }
  }

  private requestClose(): void {
    if (this.busy) return;
    this.el.close();
    this.cb.onCancel();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.exportBtn.disabled = busy || (this.info?.problem(this.selectedDepth(), this.bake.checked && !this.bake.disabled) ?? null) !== null;
    // while it runs, Cancel stops the export
    this.cancelBtn.textContent = busy ? 'Cancel export' : 'Cancel';
    this.cancelBtn.title = busy ? 'Stop exporting and throw away what was written' : '';
    this.nameInput.disabled = busy;
    this.depthInputs.forEach((i) => (i.disabled = busy));
    if (this.info) this.bake.disabled = busy || this.info.speedPitchNeutral;
    if (!busy) this.progress.hidden = true;
  }

  setProgress(label: string, fraction: number | null): void {
    this.progress.hidden = false;
    this.progressLabel.textContent = label;
    this.fill.style.width = fraction === null ? '100%' : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    this.fill.style.opacity = fraction === null ? '0.35' : '1';
  }

  showError(message: string): void {
    this.errorEl.hidden = false;
    clear(this.errorEl);
    this.errorEl.textContent = message;
  }
}
