import { describe, expect, it } from 'vitest';
import { block, checkSkin, existingSpecs, resolve, skinModes } from '../../scripts/skin-contrast';
import { readFileSync } from 'node:fs';

// SPEC-v1.3.md 5: every skin keeps the token structure, is complete, and meets WCAG AA for its text in each of its modes.

const read = (file: string): string => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');

describe.each(existingSpecs())('skin $id', (spec) => {
  it('has its text at 4.5:1 or more on the panel and the page, in every mode it has', () => {
    const rows = checkSkin(spec);
    expect(rows.length).toBeGreaterThan(0);
    const failing = rows.filter((r) => !r.ok).map((r) => `${r.mode} ${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('defines every token it uses, as a literal or through another of its tokens', () => {
    for (const { tokens } of skinModes(spec)) {
      for (const name of ['--paper', '--sleeve', '--ink', '--ink-soft', '--rule', '--label-red', '--on-red', '--mustard', '--vinyl', '--ok-text', '--warn-text', '--bad-text']) {
        expect(() => resolve(tokens, name), `${spec.id} ${name}`).not.toThrow();
      }
      for (let i = 1; i <= 5; i++) {
        expect(() => resolve(tokens, `--loop-${i}`)).not.toThrow();
        expect(() => resolve(tokens, `--loop-${i}-ink`)).not.toThrow();
      }
    }
  });

  it('keeps the established structure: the bare skin selector first, a dark look in two identical blocks, or one explicit dark look', () => {
    const css = read(spec.file);
    const light = block(css, spec.light);
    if (spec.dark) {
      const media = block(css, spec.dark.media);
      const attr = block(css, spec.dark.attr);
      expect(media).toEqual(attr);
      // every token that has a dark value is defined on the bare selector too
      for (const name of Object.keys(attr)) expect(light, `${spec.id} ${name}`).toHaveProperty([name]);
      expect(css).toContain('@media (prefers-color-scheme: dark)');
      expect(css).toContain("[data-theme='light']");
    } else {
      // a skin that is dark whatever the host says: dark colour scheme, and every colour set explicitly
      expect(css).toMatch(/color-scheme: dark;/);
      for (const name of ['--paper', '--sleeve', '--ink', '--ink-soft', '--rule', '--ok-text', '--warn-text', '--bad-text', '--on-red']) {
        expect(light, `${spec.id} ${name}`).toHaveProperty([name]);
      }
    }
  });
});
