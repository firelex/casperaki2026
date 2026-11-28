// Genre recipes (docs/superpowers/specs/2026-11-28-genre-recipes-design.md).
import { describe, expect, it } from 'vitest';

import { formatGenreTempoRange, GenreSchema, isBpmInGenreTempoRange } from '../src/schemas/common.js';
import { baseGenre, GENRE_BLURBS, GENRE_LABELS, GENRE_RECIPES, genreLabel, genreRecipe, genreTempoRange, SongGenreSchema } from '../src/genres.js';

describe('genre recipes', () => {
  it('song genres are the base genres and the recipes', () => {
    expect(SongGenreSchema.options).toEqual([...GenreSchema.options, ...Object.keys(GENRE_RECIPES)]);
    expect(SongGenreSchema.options).toContain('casperakiPop');
  });

  it('a recipe runs as its base genre; a base genre is its own base', () => {
    expect(baseGenre('casperakiPop')).toBe('brightPop');
    expect(baseGenre('edm')).toBe('edm');
    expect(() => baseGenre('polka')).toThrow(/polka/u);
    expect(genreRecipe('brightPop')).toBeUndefined();
    expect(genreRecipe('casperakiPop')).toMatchObject({ base: 'brightPop', drumLibrary: { library: 'drLuke' }, alwaysPlays: ['electricGuitarClean'] });
    expect(genreRecipe('casperakiPop')!.drumStyles.verse).toContain('authored-urban-boom-bap');
  });

  it('every song genre has a label and a blurb; EDM is shown as Dance (owner 2026-11-28)', () => {
    for (const g of SongGenreSchema.options) {
      expect(GENRE_LABELS[g], g).toBeTruthy();
      expect(GENRE_BLURBS[g], g).toBeTruthy();
    }
    expect(genreLabel('edm')).toBe('Dance');
    expect(genreLabel('casperakiPop')).toBe('Casperaki Pop');
    expect(() => genreLabel('polka')).toThrow(/polka/u);
  });

  it('a recipe takes its base genre tempo range', () => {
    expect(genreTempoRange('casperakiPop')).toEqual(genreTempoRange('brightPop'));
    expect(isBpmInGenreTempoRange('casperakiPop', 120)).toBe(true);
    expect(isBpmInGenreTempoRange('casperakiPop', 140)).toBe(false);
    expect(formatGenreTempoRange('casperakiPop')).toBe('95-129 bpm');
  });
});
