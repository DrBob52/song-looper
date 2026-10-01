import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SPEC-v1.2.md 7 and 10: the tokens are the specified ones, the two dark blocks agree, and text meets WCAG AA on both
// papers in both themes (stamps and loop colours included).

const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');

/** The declarations of the first block whose selector is `selector`: from its `{` to the `}` at the selector's indent. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const indent = /[ ]*$/.exec(css.slice(0, start))![0];
  const open = css.indexOf('{', start);
  const close = css.indexOf(`\n${indent}}`, open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

const light = block(':root {');
const darkMedia = block(":root:not([data-theme='light'])");
const darkAttr = block(":root[data-theme='dark']");

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('design tokens', () => {
  it('the light tokens are the ones in the spec, all defined on bare :root', () => {
    expect(light).toMatchObject({
      '--paper': '#efe6d6',
      '--sleeve': '#f8f2e7',
      '--ink': '#1d1915',
      '--ink-soft': '#6b6157',
      '--rule': '#d8ccb8',
      '--label-red': '#c6372c',
      '--mustard': '#d6a03d',
      '--vinyl': '#121110',
      '--ok': '#2f7a4f',
      '--warn': '#b8741a',
      '--bad': '#b3261e',
      '--loop-1': '#c6372c',
      '--loop-2': '#2e5aa8',
      '--loop-3': '#d6a03d',
      '--loop-4': '#2f7f79',
      '--loop-5': '#7a3e6e',
    });
    expect(light['--font-display']).toMatch(/^'Archivo', 'Arial Narrow', system-ui, sans-serif$/);
    expect(light['--font-body']).toMatch(/^'Archivo', system-ui, sans-serif$/);
    expect(light['--font-mono']).toMatch(/^'IBM Plex Mono', ui-monospace, Menlo, monospace$/);
  });

  it('the dark values are the ones in the spec', () => {
    expect(darkAttr).toMatchObject({
      '--paper': '#17130f',
      '--sleeve': '#221c16',
      '--ink': '#efe4d3',
      '--ink-soft': '#a8998a',
      '--rule': '#3a3027',
      '--label-red': '#e0574a',
      '--mustard': '#e3b25a',
      '--vinyl': '#0b0a09',
    });
  });

  it('the OS-dark block and the data-theme=dark block say exactly the same, and every dark token also exists on :root', () => {
    expect(darkMedia).toEqual(darkAttr);
    for (const name of Object.keys(darkAttr)) expect(light, name).toHaveProperty([name]);
    // a data-theme of light is also handled
    expect(css).toContain(":root[data-theme='light']");
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });
});

describe.each([
  ['light', light],
  ['dark', darkAttr],
] as const)('WCAG AA in the %s theme', (_name, t) => {
  const papers = ['--paper', '--sleeve'] as const;

  it('text on both papers is at least 4.5:1: ink, soft ink and the text versions of the stamp colours', () => {
    for (const fg of ['--ink', '--ink-soft', '--ok-text', '--warn-text', '--bad-text']) {
      for (const bg of papers) expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the stamp colours themselves (the tokens) stay at 3:1 or more against both papers, for the border and the ink', () => {
    for (const stamp of ['--ok', '--warn', '--bad']) {
      for (const bg of papers) expect(ratio(t[stamp]!, t[bg]!), `${stamp} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('labels: each loop colour carries its number in text of at least 4.5:1', () => {
    for (let i = 1; i <= 5; i++) {
      expect(ratio(t[`--loop-${i}-ink`]!, t[`--loop-${i}`]!), `loop ${i}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the red buttons: text on the label red is at least 4.5:1', () => {
    expect(ratio(t['--on-red']!, t['--label-red']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('mustard is never text: ink on a mustard sticker is, and reads', () => {
    expect(ratio('#1d1915', t['--mustard']!)).toBeGreaterThanOrEqual(4.5);
  });
});
