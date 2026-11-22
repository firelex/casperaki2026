/** Sizes and helpers shared by the sequencer's parts. */

export const HEADER_W = 236;
/** Track rows share the window's height between these; below the minimum the tracks scroll. */
export const MIN_ROW_H = 44;
export const MAX_ROW_H = 80;
/** The divider between two tracks. */
export const TRACK_DIVIDER_H = 4;
/** The "+ Add track" row under the tracks. */
export const ADD_ROW_H = 40;
/** Ruler rows, top to bottom: section markers, bars|beats, minutes:seconds, loop range. */
export const MARKERS_H = 22;
export const BARS_H = 22;
export const TIME_H = 16;
export const LOOP_H = 16;
export const RULER_H = MARKERS_H + BARS_H + TIME_H + LOOP_H;
/** The chord lane under the ruler. */
export const CHORD_H = 22;
export const MIN_PX_PER_BAR = 6;
export const MAX_PX_PER_BAR = 160;

/** Which grid lines fit at this zoom: beat lines, and every how many bars a bar line. */
export function gridStep(pxPerBar: number): { beats: boolean; bars: number } {
  return { beats: pxPerBar >= 40, bars: pxPerBar >= 10 ? 1 : pxPerBar >= 5 ? 2 : 4 };
}

/** Snap unit for range selection, in bars: a beat when beats are visible, else a bar. */
export function snapUnit(pxPerBar: number): number {
  return pxPerBar >= 28 ? 0.25 : 1;
}

/** Resolve a `var(--x)` colour for canvas drawing. */
export function resolveColor(css: string): string {
  const m = /^var\((--[\w-]+)\)$/u.exec(css);
  if (!m) return css;
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
  if (!v) throw new Error(`CSS colour ${m[1]} is not defined`);
  return v;
}

/** "1:23" style clock for ruler labels. */
export function clockLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Any CSS colour (a token, "red", rgb(), #rgb) as "#rrggbb", via the canvas colour parser. */
export function colorHex(css: string): string {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.fillStyle = '#000000';
  ctx.fillStyle = resolveColor(css);
  const v = ctx.fillStyle;
  if (!/^#[0-9a-f]{6}$/iu.test(v)) throw new Error(`Colour ${css} is not an opaque colour (${v})`);
  return v;
}
