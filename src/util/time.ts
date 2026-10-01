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

// ---------------------------------------------------------------------------
// Exact clock values (loop edges, target length): milliseconds in, milliseconds out
// ---------------------------------------------------------------------------

/**
 * Parse a typed clock value into seconds. Accepted: a plain number of seconds (`83.5`), `m:ss`, `m:ss.mmm`,
 * `ss.mmm`, `h:mm:ss` and `h:mm:ss.mmm`. With a colon the seconds (and, with an hour, the minutes) must be
 * below 60, so `1:75` is junk rather than 2:15. Returns null for anything else (empty text, signs, exponents,
 * more than three fields, stray characters). The result is not rounded; use `roundMs`.
 */
export function parseClock(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length > 3) return null;
  const last = parts[parts.length - 1]!;
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(last)) return null;
  const head = parts.slice(0, -1);
  if (!head.every((p) => /^\d+$/.test(p))) return null;
  const seconds = Number(last);
  if (parts.length > 1 && seconds >= 60) return null;
  if (parts.length === 3 && Number(head[1]) >= 60) return null;
  const total = head.reduce((acc, p) => acc * 60 + Number(p), 0) * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

/** Round seconds to whole milliseconds. */
export function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Format seconds as `m:ss.mmm` (or `h:mm:ss.mmm` from one hour up), to `decimals` places (default milliseconds).
 * Works on whole units so that `parseClock(formatClock(x))` gives `x` to the shown precision.
 */
export function formatClock(seconds: number, decimals = 3): string {
  const unit = 10 ** decimals;
  const t = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * unit);
  const whole = Math.floor(t / unit);
  const frac = t - whole * unit;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const head = h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
  return decimals > 0 ? `${head}.${pad(frac, decimals)}` : head;
}

/** Whole seconds, rounded down, as `m:ss` or `h:mm:ss`: how long something may be at most. */
export function formatClockFloor(seconds: number): string {
  return formatClock(Math.floor(Math.max(0, seconds) + 1e-9), 0);
}
