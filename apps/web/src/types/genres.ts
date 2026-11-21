import type { Genre } from '@casperaki/song-schema/schemas';

/** What users see for each brain genre id. */
export const GENRE_LABELS: Readonly<Record<Genre, string>> = {
  ballad: 'Ballad',
  brightPop: 'Bright pop',
  edm: 'EDM',
  latin: 'Latin',
  organicVibes: 'Organic',
  rock: 'Rock',
  schlager: 'Schlager',
  urban: 'Urban',
};

/** One-line description shown on the genre tiles. */
export const GENRE_BLURBS: Readonly<Record<Genre, string>> = {
  ballad: 'Slow, warm, piano and strings',
  brightPop: 'Upbeat radio pop',
  edm: 'Club drops and synth leads',
  latin: 'Syncopated grooves and guitars',
  organicVibes: 'Acoustic, relaxed, natural',
  rock: 'Guitars, live drums, energy',
  schlager: 'Sing-along four-to-the-floor',
  urban: 'Hip-hop and R&B beats',
};

/** Label for a stored genre id. Throws on an id this build doesn't know,
 *  so a new brain genre shows up as an error rather than a raw id. */
export function genreLabel(id: string): string {
  const label = (GENRE_LABELS as Record<string, string>)[id];
  if (label === undefined) throw new Error(`Unknown genre id "${id}" — add it to GENRE_LABELS.`);
  return label;
}
