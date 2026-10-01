import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import { makeChordFixture, waitForAnalysis } from './helpers';

/**
 * The layout guard (SPEC-v1.3.md section 1): finds text and controls that sit on top of each other, stick out of their
 * card or out of the window, and a turntable bar that covers a card at the bottom of the page.
 *
 * What it looks at, in the page itself (`audit` runs in the browser):
 *  - TEXT: every visible element that directly contains text, measured by the lines of that text (Range client rects),
 *    so a block that is wider than its words, or an inline span that wraps, cannot cause a false alarm, and text that
 *    spills out of a box is seen where it really is;
 *  - CONTROLS: every button, input, select, textarea, summary and slider, by its border box;
 *  - DECOR: every absolutely positioned element and every absolutely positioned ::before / ::after with a size (the
 *    sleeve's ring was one of those: it sat on top of the heading). Their boxes are worked out from the containing block.
 * Two of these may not intersect by more than 1 px, except a control and what is inside it. Nothing may stick out of the
 * card (`.card`, `.sleeve-face`, `.transport`, a dialog) it is in or out of the window, and a text field's value may not
 * be clipped by its own box. The turntable bar is checked on its own (it floats over the page by design) and, at the
 * bottom of the page, against every card.
 *
 * Intentional overlaps are listed with `data-overlap-ok="why"` on the element, which exempts that element and its own
 * pseudo-elements (not its children). Keep that list short and give every entry its reason where the attribute is set.
 */
export function audit(): string[] {
  const problems: string[] = [];
  const vw = document.documentElement.clientWidth;
  const CONTROL = 'button,input,select,textarea,summary,[role=slider],[role=button]';
  const visible = (el: Element): boolean => (el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const label = (el: Element): string => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    const tid = (el as HTMLElement).dataset?.testid ? `[${(el as HTMLElement).dataset.testid}]` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 22);
    return `${el.tagName.toLowerCase()}${cls}${tid}${text ? ` "${text}"` : ''}`;
  };
  const groupOf = (el: Element): string => (el.closest('.transport') ? 'bar' : el.closest('dialog') ? 'dialog' : 'page');
  const exempt = (el: Element): boolean => (el as HTMLElement).hasAttribute?.('data-overlap-ok') ?? false;
  const all = [...document.body.querySelectorAll('*')];

  interface Box {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  interface Item {
    el: Element;
    kind: 'text' | 'control' | 'decor';
    host?: Element;
    rects: Box[];
    group: string;
  }
  const items: Item[] = [];
  const range = document.createRange();
  for (const el of all) {
    if (el.matches('script,style,option,optgroup,input[type=hidden],svg,svg *,.sr-only') || !visible(el)) continue;
    const cs = getComputedStyle(el);
    if (exempt(el)) continue;
    // a box clipped to a pixel or two (visually hidden text) has no text to overlap
    const own = el.getBoundingClientRect();
    if (cs.overflow !== 'visible' && (own.width <= 2 || own.height <= 2) && !el.matches(CONTROL)) continue;
    // the lines of a text: a Range reports the font's whole content area, which is taller than the line when the
    // line-height is tight (the numbers on a record label), so each line is cut down to the line box, centred
    const lineHeight = parseFloat(cs.lineHeight);
    if (el.matches(CONTROL)) {
      const r = el.getBoundingClientRect();
      if (r.width > 1.5 && r.height > 1.5) items.push({ el, kind: 'control', rects: [r], group: groupOf(el) });
    } else {
      const rects: Box[] = [];
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent!.trim()) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (!(r.width > 1.5 && r.height > 1.5)) continue;
          const h = Number.isFinite(lineHeight) && lineHeight < r.height ? lineHeight : r.height;
          const mid = (r.top + r.bottom) / 2;
          rects.push({ left: r.left, right: r.right, top: mid - h / 2, bottom: mid + h / 2 });
        }
      }
      if (rects.length) items.push({ el, kind: 'text', rects, group: groupOf(el) });
      else if ((cs.position === 'absolute' || cs.position === 'fixed') && !el.classList.contains('sr-only')) {
        const r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) items.push({ el, kind: 'decor', rects: [r], group: groupOf(el) });
      }
    }
    // absolutely positioned pseudo-elements: their box comes from the containing block and the used offsets
    for (const pseudo of ['::before', '::after'] as const) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
      if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
      let cb: Element | null = el;
      while (cb && getComputedStyle(cb).position === 'static') cb = cb.parentElement;
      const cr = (cb ?? document.documentElement).getBoundingClientRect();
      const cbs = cb ? getComputedStyle(cb) : null;
      const bl = cbs ? parseFloat(cbs.borderLeftWidth) : 0;
      const bt = cbs ? parseFloat(cbs.borderTopWidth) : 0;
      const br = cbs ? parseFloat(cbs.borderRightWidth) : 0;
      const bb = cbs ? parseFloat(cbs.borderBottomWidth) : 0;
      const w = parseFloat(ps.width);
      const h = parseFloat(ps.height);
      if (!(w > 4) || !(h > 4)) continue;
      const num = (v: string): number => (v === 'auto' ? NaN : parseFloat(v));
      let x = num(ps.left) + cr.left + bl;
      let y = num(ps.top) + cr.top + bt;
      if (Number.isNaN(x)) x = cr.right - br - num(ps.right) - w;
      if (Number.isNaN(y)) y = cr.bottom - bb - num(ps.bottom) - h;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const m = /^matrix\(([^)]+)\)$/.exec(ps.transform);
      if (m) {
        const v = m[1]!.split(',').map(Number);
        x += v[4] ?? 0;
        y += v[5] ?? 0;
      }
      items.push({ el: el, host: el, kind: 'decor', rects: [{ left: x, top: y, right: x + w, bottom: y + h }], group: groupOf(el) });
    }
  }

  const overlap = (a: Box, b: Box): number[] => [Math.min(a.right, b.right) - Math.max(a.left, b.left), Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)];
  const describe = (it: Item): string => (it.host ? `${label(it.el)} (its ::before/::after)` : label(it.el));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.group !== b.group) continue;
      if (a.kind === 'decor' && b.kind === 'decor') continue;
      // a control holds what is inside it (a record drawn in a button, the words next to it)
      if ((a.kind === 'control' && !a.host && a.el.contains(b.el) && a.el !== b.el) || (b.kind === 'control' && !b.host && b.el.contains(a.el) && a.el !== b.el)) continue;
      // a pseudo-element is part of its host, not of the text it carries itself
      if (a.host && a.el === b.el && b.kind !== 'text') continue;
      if (b.host && a.el === b.el && a.kind !== 'text') continue;
      for (const ra of a.rects) {
        for (const rb of b.rects) {
          const [ox, oy] = overlap(ra, rb);
          if (ox > 1 && oy > 1) problems.push(`overlap ${ox.toFixed(1)} x ${oy.toFixed(1)} px: ${describe(a)}  and  ${describe(b)}`);
        }
      }
    }
  }

  // nothing sticks out of its card or out of the window
  for (const it of items) {
    const card = it.el.closest('.card, .transport, dialog, .sleeve-face');
    const box = card ? card.getBoundingClientRect() : { left: 0, right: vw, top: -1e9, bottom: 1e9 };
    for (const r of it.rects) {
      if (r.left < box.left - 0.6 || r.right > box.right + 0.6) {
        problems.push(`sticks out of ${card ? label(card) : 'the window'}: ${describe(it)} ${Math.round(r.left)}..${Math.round(r.right)} in ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
      if (card && (r.top < box.top - 0.6 || r.bottom > box.bottom + 0.6)) {
        problems.push(`sticks out (vertically) of ${label(card)}: ${describe(it)} ${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(box.top)}..${Math.round(box.bottom)}`);
      }
      if (r.left < -0.6 || r.right > vw + 0.6) problems.push(`outside the window: ${describe(it)} ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    }
  }
  // a typed value clipped by its own box
  for (const el of all) {
    if (el instanceof HTMLInputElement && el.type === 'text' && visible(el) && el.scrollWidth > el.clientWidth + 1) {
      problems.push(`value clipped in ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
    problems.push(`horizontal scroll: ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
  }
  return problems;
}

/** The turntable bar and every card, for the check at the bottom of the page. */
export function barCoversCards(): string[] {
  const bar = document.querySelector('.transport') as HTMLElement | null;
  if (!bar || bar.hidden) return [];
  const b = bar.getBoundingClientRect();
  const out: string[] = [];
  for (const card of document.querySelectorAll('.card, .sleeve-face')) {
    if (!(card as HTMLElement).checkVisibility()) continue;
    const r = card.getBoundingClientRect();
    const ox = Math.min(b.right, r.right) - Math.max(b.left, r.left);
    const oy = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
    if (ox > 1 && oy > 1) out.push(`the turntable bar covers ${(card.getAttribute('aria-label') ?? card.className) || 'a card'} by ${oy.toFixed(1)} px`);
  }
  return out;
}

/** Let the layout settle after a resize, a skin change or an edit: two frames and the waveform's redraw. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForTimeout(350);
}

/** Run the guard on the page as it is now, and (when a song is loaded) at the bottom of the page. Returns the problems. */
export async function auditPage(page: Page, what: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  const found = await page.evaluate(audit);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await settle(page);
  found.push(...(await page.evaluate(barCoversCards)));
  await page.evaluate(() => window.scrollTo(0, 0));
  return found.map((p) => `${what}: ${p}`);
}

/** The loaded state of SPEC-v1.3.md 1: a song with two loops (one bridged, one rough with a nearby suggestion), a cut, and an end point with a fade. */
export async function loadBusyPage(page: Page): Promise<void> {
  const fixture = await makeChordFixture({ progressions: { A: 'C G Am F', B: 'Dm Em F G' }, structure: 'ABABABAB' }, 'demo-chords.wav');
  await page.goto('/');
  await page.setInputFiles('[data-testid=file-input]', { name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
  await page.waitForSelector('[data-testid=song-panel]:not([hidden])');
  await waitForAnalysis(page);
  const add = (a: number, b: number): Promise<unknown> =>
    page.evaluate(([s, e]) => (window as unknown as { songLooper: { addLoop(x: { start: number; end: number }): string | null } }).songLooper.addLoop({ start: s!, end: e! }), [a, b]);
  await add(0, 8);
  await page.getByTestId('bridge-toggle').first().check();
  await expect(page.getByTestId('bridge-status').first()).toHaveText(/^Bridge: 4 bars/);
  await add(16, 30);
  await expect(page.getByTestId('nearby').nth(1)).toBeVisible();
  await expect(page.getByTestId('seam-chip').nth(1)).toHaveText('Rough');
  await page.getByTestId('repeats').first().fill('3');
  await page.getByTestId('repeats').first().press('Enter');
  // one cut
  await page.evaluate(() => (window as unknown as { songLooper: { addCut(x: { start: number; end: number }): string | null } }).songLooper.addCut({ start: 40, end: 44 }));
  await expect(page.getByTestId('cut')).toHaveCount(1);
  // an end point 10 s before the end of the extended song, and a fade into it
  await page.evaluate(() => {
    const a = (window as unknown as { songLooper: { naturalSeconds(): number; setEndingMode(m: string): void; setEndAt(s: number): string | null; setFade(s: number): string | null } }).songLooper;
    a.setEndingMode('at');
    a.setEndAt(Math.floor((a.naturalSeconds() - 10) * 1000) / 1000);
    a.setFade(6);
  });
  await expect(page.getByTestId('length-ending')).toContainText('fades over 6 s');
}
