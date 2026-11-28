// A derived genre (genre recipe) reaches the engine as its base genre: the engine's mix tables know only those
// (docs/superpowers/specs/2026-11-28-genre-recipes-design.md).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SongSchema, type Song } from '@casperaki/song-schema';
import { describe, expect, it } from 'vitest';

import { toEngineFixture } from '../src/index.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const song = (genre: string): Song => ({ ...SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8'))), genre }) as Song;
const engineGenre = (genre: string) => (JSON.parse(JSON.stringify(toEngineFixture(song(genre), { brainHash: 'x', generatorParams: {} }).songJson)) as { genre?: string }).genre;

describe('genre to the engine', () => {
  it('a recipe genre goes as its base genre; a base genre as itself', () => {
    expect(engineGenre('casperakiPop')).toBe('brightPop');
    expect(engineGenre('edm')).toBe('edm');
  });
});
