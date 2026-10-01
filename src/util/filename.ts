/**
 * A name that is safe to give a file on every system: control characters and the characters Windows does not allow in a
 * file name (`\ / : * ? " < > |`) become `_`, and `.wav` is added when it is missing. Never empty.
 */
export function sanitizeFilename(name: string): string {
  let n = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  if (!n) n = 'extended';
  if (!/\.wav$/i.test(n)) n += '.wav';
  return n;
}
