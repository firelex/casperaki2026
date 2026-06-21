#!/usr/bin/env node
// Regenerates committed golden fixtures from the current generator code.
// CI never runs this — humans run it deliberately when a musical change
// lands and the diff is part of the review.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createRng } from '@casperaki/music-theory';
import { stableStringify } from '@casperaki/song-schema';

import { generateSongStructure } from '../src/structure/index.js';
import { generateChords } from '../src/chords/index.js';
import { selectInstruments } from '../src/selection/index.js';
import { generatePatterns } from '../src/patterns/index.js';
import { generateVocalMelody } from '../src/vocals/index.js';
import { orchestrate } from '../src/orchestrate/index.js';
import { canonicalStringifySong } from '@casperaki/song-schema';
import {
  CHORDS_GOLDEN_CASES,
  ORCHESTRATE_GOLDEN_CASES,
  PATTERNS_GOLDEN_CASES,
  SELECTION_GOLDEN_CASES,
  STRUCTURE_GOLDEN_CASES,
  VOCALS_GOLDEN_CASES,
  chordsGoldenPath,
  orchestrateGoldenPath,
  patternsGoldenPath,
  selectionGoldenPath,
  structureGoldenPath,
  vocalsGoldenPath,
} from '../test/fixtures.js';

function makeCtx({ genre, key, seed }) {
  return {
    rng: createRng(seed),
    params: { genre, key, bpm: 120, seed },
  };
}

async function writeGolden(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stableStringify(value, 2)}\n`, 'utf8');
  console.log(`wrote ${path}`);
}

async function main() {
  for (const c of STRUCTURE_GOLDEN_CASES) {
    const structure = generateSongStructure(makeCtx(c));
    await writeGolden(structureGoldenPath(c.genre, c.seed), structure);
  }
  for (const c of CHORDS_GOLDEN_CASES) {
    const ctx = makeCtx(c);
    const structure = generateSongStructure(ctx);
    const withChords = generateChords(ctx, structure);
    await writeGolden(chordsGoldenPath(c.genre, c.seed), withChords);
  }
  for (const c of SELECTION_GOLDEN_CASES) {
    const ctx = makeCtx(c);
    const structure = generateSongStructure(ctx);
    const selection = selectInstruments(ctx, structure);
    await writeGolden(selectionGoldenPath(c.genre, c.seed), selection);
  }
  for (const c of PATTERNS_GOLDEN_CASES) {
    const ctx = makeCtx(c);
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    await writeGolden(patternsGoldenPath(c.genre, c.seed), patterns);
  }
  for (const c of VOCALS_GOLDEN_CASES) {
    const ctx = makeCtx(c);
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const vocals = generateVocalMelody(ctx, structure);
    await writeGolden(vocalsGoldenPath(c.genre, c.seed), vocals);
  }
  for (const c of ORCHESTRATE_GOLDEN_CASES) {
    const song = orchestrate({ genre: c.genre, key: c.key, bpm: c.bpm ?? 120, seed: c.seed });
    // Use canonicalStringifySong so the golden carries the same byte-for-byte
    // serialization the brain's replay endpoint will hash later.
    const path = orchestrateGoldenPath(c.genre, c.seed);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${canonicalStringifySong(song, 2)}\n`, 'utf8');
    console.log(`wrote ${path}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
