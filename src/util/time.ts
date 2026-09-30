/** Format seconds as m:ss (or h:mm:ss for long durations), optionally with tenths. */
export function formatTime(seconds: number, decimals = 0): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const factor = 10 ** decimals;
  const total = Math.round(seconds * factor) / factor;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const sStr = decimals > 0 ? s.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.floor(s)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`;
}

/**
 * Parse "mm:ss", "h:mm:ss", "ss" or "mm:ss.s" into seconds. Returns null when
 * the text is not a valid time.
 */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return Number.isFinite(total) ? total : null;
}
