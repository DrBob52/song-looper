/**
 * WCAG AA contrast of every skin's text tokens (SPEC-v1.3.md 5.3), in both modes where a skin has both.
 *
 *   npx tsx scripts/skin-contrast.ts        prints a table and exits 1 if any text pair is under 4.5:1
 *
 * The tokens are read from the CSS itself: the bare skin selector (the light values), and for the skins with a dark look
 * the two dark blocks (under prefers-color-scheme, and for data-theme='dark'), which must say the same. The component
 * names (--paper, --sleeve, --label-red, ...) may point at the spec's names with var(), which is followed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Tokens = Record<string, string>;

const root = new URL('../src/', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');

/** The declarations of the first block whose selector text is `selector`, from its `{` to the `}` at its own indent. */
export function block(css: string, selector: string): Tokens {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const lineStart = css.lastIndexOf('\n', start) + 1;
  const indent = /^[ ]*/.exec(css.slice(lineStart, start))![0];
  const open = css.indexOf('{', start);
  const close = css.indexOf(`\n${indent}}`, open);
  const vars: Tokens = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

export interface SkinSpec {
  id: string;
  /** The stylesheet that holds it, relative to src/. */
  file: string;
  /** Selector of the block with the light (or only) values. */
  light: string;
  /** Selectors of the two dark blocks; null for a skin that has only one look. */
  dark: { media: string; attr: string } | null;
}

export const SKIN_SPECS: SkinSpec[] = [
  {
    id: 'vinyl',
    file: 'style.css',
    light: ':root {',
    dark: { media: ":root:not([data-theme='light'])", attr: ":root[data-theme='dark']" },
  },
  ...['pro', 'space'].map(
    (id): SkinSpec => ({
      id,
      file: `skins/${id}.css`,
      light: `:root[data-skin='${id}'] {`,
      dark: { media: `:root[data-skin='${id}']:not([data-theme='light'])`, attr: `:root[data-skin='${id}'][data-theme='dark']` },
    }),
  ),
  ...['studio', 'club'].map((id): SkinSpec => ({ id, file: `skins/${id}.css`, light: `:root[data-skin='${id}'] {`, dark: null })),
];

/** Skins whose stylesheet exists (a skin is added to the app one milestone at a time). */
export function existingSpecs(): SkinSpec[] {
  return SKIN_SPECS.filter((s) => {
    try {
      read(s.file);
      return true;
    } catch {
      return false;
    }
  });
}

/** Follow `var(--x)` to a literal. */
export function resolve(tokens: Tokens, name: string, seen: string[] = []): string {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`token ${name} is not defined`);
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  if (!m) return raw;
  if (seen.includes(name)) throw new Error(`token ${name} refers to itself`);
  return resolve(tokens, m[1]!, [...seen, name]);
}

function luminance(hex: string): number {
  const full = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.test(hex) ? hex.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : hex;
  if (!/^#[0-9a-f]{6}$/i.test(full)) throw new Error(`not a plain hex colour: ${hex}`);
  const n = parseInt(full.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The token sets of a skin: its light (or only) mode, and its dark mode when it has one. */
export function skinModes(spec: SkinSpec): { mode: 'light' | 'dark'; tokens: Tokens }[] {
  const css = read(spec.file);
  const light = block(css, spec.light);
  if (!spec.dark) return [{ mode: 'dark', tokens: light }];
  const dark = block(css, spec.dark.attr);
  return [
    { mode: 'light', tokens: light },
    { mode: 'dark', tokens: { ...light, ...dark } },
  ];
}

export interface Row {
  skin: string;
  mode: 'light' | 'dark';
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  ok: boolean;
}

/**
 * Text on its backgrounds: ink, soft ink and the stamp texts on the panel and the page; the accent as text on the panel;
 * the text on a solid accent button, on every loop colour (the number on a loop's label), on a section sticker.
 */
export function checkSkin(spec: SkinSpec): Row[] {
  const rows: Row[] = [];
  for (const { mode, tokens } of skinModes(spec)) {
    const add = (fg: string, bg: string, min = 4.5): void => {
      const r = ratio(resolve(tokens, fg), resolve(tokens, bg));
      rows.push({ skin: spec.id, mode, fg, bg, ratio: r, min, ok: r >= min });
    };
    for (const fg of ['--ink', '--ink-soft', '--ok-text', '--warn-text', '--bad-text']) {
      for (const bg of ['--sleeve', '--paper']) add(fg, bg);
    }
    // the accent is text only inside the cards (the track numbers, the arrow between the lengths)
    add('--label-red', '--sleeve');
    add('--on-red', '--label-red');
    add('--sticker-ink', '--mustard');
    for (let i = 1; i <= 5; i++) add(`--loop-${i}-ink`, `--loop-${i}`);
  }
  return rows;
}

export function checkAll(): Row[] {
  return existingSpecs().flatMap(checkSkin);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = checkAll();
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.skin.padEnd(7)} ${r.mode.padEnd(5)} ${r.fg.padEnd(14)} on ${r.bg.padEnd(9)} ${r.ratio.toFixed(2)}:1 (need ${r.min})`);
  }
  console.log(`${rows.length} pairs, ${bad} under their minimum`);
  process.exit(bad ? 1 : 0);
}
