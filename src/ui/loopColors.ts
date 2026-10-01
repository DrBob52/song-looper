import { REGION_COLORS } from '../model';
import { cssVar } from './dom';

/** Index (0 to 4) of a stored loop colour in the palette, or -1 for any other colour. */
function paletteIndex(color: string): number {
  return REGION_COLORS.indexOf(color);
}

/**
 * A CSS colour for a stored loop colour. The five palette colours come back as `var(--loop-N)`, so they follow the
 * theme (lighter on the dark paper); any other colour is used as given.
 */
export function loopCss(color: string): string {
  const i = paletteIndex(color);
  return i >= 0 ? `var(--loop-${i + 1})` : color;
}

/** The text colour that reads on a loop's colour (white on most, ink on mustard; ink on all of them in the dark theme). */
export function loopInkCss(color: string): string {
  const i = paletteIndex(color);
  return i >= 0 ? `var(--loop-${i + 1}-ink)` : '#fff';
}

/** The loop colour as the page shows it right now, as a literal (for canvas and rgba() work). */
export function loopResolved(color: string): string {
  const i = paletteIndex(color);
  return (i >= 0 && cssVar(`--loop-${i + 1}`)) || color;
}
