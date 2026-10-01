/**
 * Skins (SPEC-v1.3.md 5): the look of the app. Every skin shares the same markup and test ids; a skin changes tokens,
 * type, borders, decoration and how the play button is drawn, all in CSS under `:root[data-skin='...']`. The skin is
 * `data-skin` on <html> (not `data-theme`, which claude.ai sets for light and dark).
 */

export type SkinId = 'vinyl' | 'studio' | 'club' | 'pro' | 'space';

export interface SkinInfo {
  id: SkinId;
  name: string;
  /** What the button says on a narrow window. */
  short: string;
  /** One line, shown as the tooltip of its button. */
  blurb: string;
  /** Does it have a light and a dark look, or is it dark whatever the host says? */
  modes: 'light-dark' | 'dark';
  /**
   * The Google Fonts stylesheet it needs, added to the page the first time the skin is chosen (null: loaded by
   * index.html, or none). Google Fonts is the only external host the app uses.
   */
  fonts: string | null;
  /** Three colours of its look, for the swatch on its button (not tokens: they preview a skin that is not the current one). */
  swatch: [string, string, string];
}

const GF = 'https://fonts.googleapis.com/css2';

export const SKINS: readonly SkinInfo[] = [
  {
    id: 'vinyl',
    name: 'Vinyl',
    short: 'Vinyl',
    blurb: 'Warm paper sleeves, ink black, a spinning record',
    modes: 'light-dark',
    // Archivo and IBM Plex Mono come from the <link> in index.html, as they always have
    fonts: null,
    swatch: ['#efe6d6', '#1d1915', '#c6372c'],
  },
  {
    id: 'studio',
    name: 'Studio hardware',
    short: 'Studio',
    blurb: 'A high-end sampler: dark panels, an amber LCD, LEDs',
    modes: 'dark',
    fonts: `${GF}?family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400;500;600&family=VT323&display=swap`,
    swatch: ['#141517', '#ffb000', '#3ddc6a'],
  },
  {
    id: 'club',
    name: 'Night club',
    short: 'Club',
    blurb: 'Dark glass, neon magenta and cyan',
    modes: 'dark',
    fonts: `${GF}?family=Unbounded:wght@700;800&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap`,
    swatch: ['#07060b', '#ff2fb9', '#19e3ff'],
  },
  {
    id: 'pro',
    name: 'Clean pro tool',
    short: 'Pro',
    blurb: 'A calm modern DAW: hairlines, one accent',
    modes: 'light-dark',
    fonts: `${GF}?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap`,
    swatch: ['#f5f6f8', '#16181d', '#3d6df2'],
  },
  {
    id: 'space',
    name: 'Space age',
    short: 'Space',
    blurb: '1960s hi-fi: moulded plastic, chrome, a phosphor scope',
    modes: 'light-dark',
    fonts: `${GF}?family=Michroma&family=Exo+2:wght@400;500;600;700&family=Share+Tech+Mono&display=swap`,
    swatch: ['#ebe5d8', '#e8622a', '#1f7a78'],
  },
];

export const DEFAULT_SKIN: SkinId = 'vinyl';
/** Where the choice is kept (localStorage); index.html reads the same key before the first paint. */
export const SKIN_STORAGE_KEY = 'song-looper-skin';

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === 'string' && SKINS.some((s) => s.id === value);
}

export function skinInfo(id: SkinId): SkinInfo {
  return SKINS.find((s) => s.id === id) ?? SKINS[0]!;
}

/** The skin the user chose last, or Vinyl: storage can be missing, blocked or hold junk. */
export function loadSkinChoice(): SkinId {
  try {
    const stored = localStorage.getItem(SKIN_STORAGE_KEY);
    return isSkinId(stored) ? stored : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

export function saveSkinChoice(id: SkinId): void {
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
    /* private window or blocked storage: the choice just is not remembered */
  }
}

const injected = new Set<string>();

/**
 * Add a skin's Google Fonts stylesheet to the page, once, the first time the skin is used. A request that fails (blocked,
 * offline) leaves the fallback fonts of the skin's font stacks in place; nothing else changes.
 */
export function ensureSkinFonts(id: SkinId, doc: Document = document): void {
  const url = skinInfo(id).fonts;
  if (!url || injected.has(url)) return;
  injected.add(url);
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.skinFonts = id;
  doc.head.append(link);
}

/** Make a skin the page's look: `data-skin` on <html> and its fonts. Does not remember the choice. */
export function applySkin(id: SkinId, doc: Document = document): void {
  doc.documentElement.dataset.skin = id;
  ensureSkinFonts(id, doc);
}
