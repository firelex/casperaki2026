/**
 * The song drawn in the landing page's hero: a real-shaped arrangement
 * (sections × instrument lanes) using the app's own segment and lane
 * colours and public sound names. Static data — it illustrates what the
 * editor shows; it is not fetched from the brain.
 */

export interface HeroSection {
  readonly name: string;
  readonly bars: number;
  /** CSS colour token used by the editor for this section kind. */
  readonly color: string;
}

export interface HeroLane {
  readonly role: string;
  readonly sound: string;
  readonly color: string;
  /** Which sections (by index) this lane plays in. */
  readonly plays: readonly number[];
  /** Notes per bar drawn inside a block: higher reads busier. */
  readonly density: number;
}

export const HERO_SECTIONS: readonly HeroSection[] = [
  { name: 'Intro', bars: 4, color: 'var(--color-seg-intro)' },
  { name: 'Verse', bars: 8, color: 'var(--color-seg-verse)' },
  { name: 'Pre-chorus', bars: 4, color: 'var(--color-seg-prechorus)' },
  { name: 'Chorus', bars: 8, color: 'var(--color-seg-chorus)' },
  { name: 'Verse', bars: 8, color: 'var(--color-seg-verse)' },
  { name: 'Chorus', bars: 8, color: 'var(--color-seg-chorus)' },
  { name: 'Bridge', bars: 4, color: 'var(--color-seg-bridge)' },
  { name: 'Chorus', bars: 8, color: 'var(--color-seg-chorus)' },
  { name: 'Outro', bars: 4, color: 'var(--color-seg-outro)' },
];

export const HERO_LANES: readonly HeroLane[] = [
  { role: 'Drums', sound: 'Snappy Tornado', color: 'var(--color-c0)', plays: [1, 2, 3, 4, 5, 7], density: 4 },
  { role: 'Bass', sound: 'Seismic Undertow', color: 'var(--color-c1)', plays: [1, 2, 3, 4, 5, 6, 7, 8], density: 2 },
  { role: 'Keys', sound: 'Hazy Chapel', color: 'var(--color-c2)', plays: [0, 1, 4, 6, 8], density: 3 },
  { role: 'Pad', sound: 'Retro Neon', color: 'var(--color-c3)', plays: [0, 2, 3, 5, 6, 7, 8], density: 1 },
  { role: 'Lead', sound: 'Glowing Flux', color: 'var(--color-c4)', plays: [3, 5, 7], density: 3 },
];

/** Deterministic note heights for a block, so the drawing is stable. */
export function noteHeights(laneIndex: number, sectionIndex: number, count: number): number[] {
  let x = (laneIndex + 1) * 7919 + (sectionIndex + 1) * 104729;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(0.25 + (x / 2147483648) * 0.6);
  }
  return out;
}
