import { downloadBlob } from './wav';
import { zipSingleFile } from './zip';

// When the app is published as a claude.ai artifact, the page cannot start
// downloads itself. It asks the viewer through the `downloads` capability,
// which accepts .zip but not .wav, so the WAV goes inside a zip there.
// Everywhere else (local dev, GitHub Pages) it is a plain WAV download.

interface DownloadsCapability {
  save(req: { filename: string; data: Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}

interface ClaudeHost {
  use(name: 'downloads'): Promise<DownloadsCapability | null>;
}

function host(): ClaudeHost | null {
  const c = (window as unknown as { claude?: Partial<ClaudeHost> }).claude;
  return c && typeof c.use === 'function' ? (c as ClaudeHost) : null;
}

/** Start resolving the capability early so the export click isn't kept waiting. */
export function warmUpSave(): void {
  void host()?.use('downloads').catch(() => null);
}

export type SaveOutcome = 'downloaded' | 'saved-zip';

export async function saveWav(blob: Blob, filename: string): Promise<SaveOutcome> {
  const claude = host();
  const downloads = claude ? await claude.use('downloads').catch(() => null) : null;
  if (!downloads) {
    downloadBlob(blob, filename);
    return 'downloaded';
  }
  const zip = await zipSingleFile(filename, blob);
  const zipName = filename.replace(/\.wav$/i, '') + '.zip';
  try {
    await downloads.save({ filename: zipName, data: zip });
    return 'saved-zip';
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'declined') throw new Error('Save cancelled. Press Export to try again.', { cause: err });
    if (code === 'rate_limited') throw new Error('A save prompt is already open. Finish it, then try again.', { cause: err });
    throw new Error('Saving files is not available in this view. Run the app locally to export.', { cause: err });
  }
}
