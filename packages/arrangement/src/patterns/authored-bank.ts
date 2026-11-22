// Approved Casperaki-written styles for the pitched families and guitar
// (pattern lab). Drums and bass keep their own banks (drums/bank-index.json
// styles, bass/bank-index.json `authored`).
//
// data/patterns/authored/index.json:
//   { "$schemaVersion": 1, "styles": { "<style>": { "family", "kind", "genres", "file" } } }
// with each file holding the style's patterns (see chord-tones.ts). The file
// is written by apps/brain/scripts/export-approved-patterns.ts.
//
// A lane plays an approved style alongside the legacy generator: with n
// styles for its family and genre, it takes one of them n times in n + 1
// (see patterns/index.ts). With none, nothing is drawn and songs stay as
// they were.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { GenreSchema } from '@casperaki/song-schema';

import { InstrumentFamilySchema, type InstrumentFamily } from '../selection/types.js';
import {
  ChordTonePatternSchema,
  energyCoverageProblem,
  familyTakesKind,
  GuitarPickPatternSchema,
  type AuthoredPatterns,
} from './chord-tones.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where approved pitched-family and guitar styles live. */
export const AUTHORED_BANK_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'authored');

const IndexSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string().optional(),
    styles: z.record(
      z.string().min(1),
      z
        .object({
          family: InstrumentFamilySchema,
          kind: z.enum(['chordTones', 'guitarPicks']),
          genres: z.array(GenreSchema).min(1),
          file: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export interface AuthoredStyle {
  readonly styleName: string;
  readonly family: InstrumentFamily;
  readonly genres: readonly string[];
  readonly patterns: AuthoredPatterns;
}

let cached: readonly AuthoredStyle[] | undefined;

function load(dir: string): AuthoredStyle[] {
  const indexPath = resolve(dir, 'index.json');
  const index = IndexSchema.parse(JSON.parse(readFileSync(indexPath, 'utf8')));
  return Object.entries(index.styles).map(([styleName, entry]) => {
    if (!familyTakesKind(entry.family, entry.kind)) throw new Error(`authored/index.json: "${styleName}": family ${entry.family} cannot play ${entry.kind}`);
    const raw = JSON.parse(readFileSync(resolve(dir, entry.file), 'utf8')) as unknown;
    const patterns: AuthoredPatterns =
      entry.kind === 'chordTones'
        ? { kind: 'chordTones', patterns: z.array(ChordTonePatternSchema).min(1).parse(raw) }
        : { kind: 'guitarPicks', patterns: z.array(GuitarPickPatternSchema).min(1).parse(raw) };
    const problem = energyCoverageProblem(patterns.patterns);
    if (problem) throw new Error(`authored/${entry.file}: ${problem}`);
    return { styleName, family: entry.family, genres: entry.genres, patterns };
  });
}

/** Approved styles for one family in one genre. */
export function authoredStylesFor(family: InstrumentFamily, genre: string, dir: string = AUTHORED_BANK_DIR): AuthoredStyle[] {
  const all = dir === AUTHORED_BANK_DIR ? (cached ??= load(dir)) : load(dir);
  return all.filter((s) => s.family === family && s.genres.includes(genre));
}

/** Names of every approved style in the bank. */
export function authoredStyleNames(dir: string = AUTHORED_BANK_DIR): string[] {
  return load(dir).map((s) => s.styleName);
}

/** Test-only — drop the cache so the next call re-reads disk. */
export function _resetAuthoredBankCache(): void {
  cached = undefined;
}
