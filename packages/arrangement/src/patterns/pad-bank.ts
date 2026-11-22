// Legacy-derived pad pattern bank — loader + selector.
//
// The legacy PadPatternGeneratorClass dispatches to a single
// ChordsAndNotesPadPatternGeneratorClass with a `style` parameter
// selected from a 9-element vocabulary. Every style emits a single hit
// on beat 0 of every bar with a full-bar (duration=4) sustain — the
// rhythmic shape is identical across the nine styles. What differs is
// the engine-side voicing:
//
//   - The six `chords*` styles emit a chord event carrying the bar's
//     first chord symbol; the legacy `chordType` strings
//     (`oneOctaveHigh`, `twoOctavesMid`, …) are engine voicing hints
//     the brain does not currently carry through the Song schema.
//   - The three `singleNote*` styles emit a single-note event whose
//     pitch is the chord root in a fixed MIDI octave (5 → High, 4 →
//     Mid, 3 → Low) — legacy applier's
//     `_addNoteAbsolute(0, Tools.getChordBaseNote(chord) + '5', 4)`.
//
// The brain selects one style per pad-active segment via
// `ctx.rng.fork('patterns/pad')`. The legacy oneOctave / twoOctaves
// distinction inside the chord styles is voicing metadata recorded on
// the bank selection for downstream consumers (engine adapter, studio
// UI) but not surfaced in the emitted brain events. See docs/53x for
// the deferred engine-adapter wiring.
//
// Legacy source files (manifest-only — there is no per-style data
// file; each style is fully specified by its bank-index entry):
//   - data/patterns/pad/bank-index.json (authored here, mirrors the
//     9 styles ChordsAndNotesPadPatternGeneratorClass.createPadPattern
//     accepts).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { GenreSchema, type Genre } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'pad');

// ---- schemas ----

const ChordStyleSchema = z
  .object({
    kind: z.literal('chord'),
    voicing: z.enum([
      'oneOctaveHigh',
      'oneOctaveMid',
      'oneOctaveLow',
      'twoOctavesHigh',
      'twoOctavesMid',
      'twoOctavesLow',
    ]),
  })
  .strict();

const SingleNoteStyleSchema = z
  .object({
    kind: z.literal('singleNote'),
    /** Note-name octave of the legacy C template ('C5' → 5); see pad.ts. */
    templateOctave: z.number().int().min(0).max(8),
  })
  .strict();

const PadStyleSchema = z.union([ChordStyleSchema, SingleNoteStyleSchema]);

const BankIndexSchema = z.object({
  $schemaVersion: z.literal(1),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.unknown()).optional(),
  barBeats: z.number().int().positive(),
  barDuration: z.number().positive(),
  styles: z.record(z.string().min(1), PadStyleSchema),
  genreStyles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

// ---- public types ----

export type PadStyle = z.infer<typeof PadStyleSchema>;
export type PadChordVoicing = Extract<PadStyle, { kind: 'chord' }>['voicing'];

export interface PadBankSelection {
  readonly styleName: string;
  readonly style: PadStyle;
  readonly barBeats: number;
  readonly barDuration: number;
}

// ---- loader ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/padPatterns/{PadPatternGeneratorClass,ChordsAndNotesPadPatternGeneratorClass}.js',
  extractedAt: '2026-06-06',
};

interface ResolvedBank {
  readonly index: z.infer<typeof BankIndexSchema>;
}

let cached: ResolvedBank | undefined;

function loadBank(): ResolvedBank {
  if (cached) return cached;
  const indexPath = resolve(DATA_DIR, BANK_INDEX_META.filename);
  let indexRaw: unknown;
  try {
    indexRaw = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (err) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `failed to load: ${(err as Error).message}`,
      err,
    );
  }
  const indexParse = BankIndexSchema.safeParse(indexRaw);
  if (!indexParse.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `manifest is malformed: ${indexParse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const index = indexParse.data;

  for (const [genre, styleList] of Object.entries(index.genreStyles)) {
    for (const styleName of styleList) {
      if (index.styles[styleName] === undefined) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `genreStyles["${genre}"] references unknown style "${styleName}"`,
        );
      }
    }
  }

  cached = { index };
  return cached;
}

/** Test-only — drop the in-memory cache so a re-load re-reads disk. */
export function _resetPadBankCache(): void {
  cached = undefined;
}

// ---- selection ----

function stylesForGenre(genre: Genre): readonly string[] {
  const bank = loadBank();
  const list = bank.index.genreStyles[genre];
  if (!list || list.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `no pad style is mapped to genre "${genre}" — extend bank-index.json's genreStyles`,
    );
  }
  return list;
}

/**
 * Deterministically pick one legacy pad style for `genre`, using a
 * caller-owned `Rng` (the brain forks `ctx.rng.fork('patterns/pad')`).
 *
 * Throws `DataAssetError` on a non-canonical genre, on an empty style
 * list, or on any bank-data malformation. Mirrors the contract of the
 * sibling drums / bass / keys selectors.
 */
export function selectPadStyle(rng: Rng, genre: string): PadBankSelection {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  const bank = loadBank();
  const list = stylesForGenre(parsed.data);
  const idx = rng.int(0, list.length - 1);
  const styleName = list[idx]!;
  const style = bank.index.styles[styleName]!;
  return {
    styleName,
    style,
    barBeats: bank.index.barBeats,
    barDuration: bank.index.barDuration,
  };
}

/** Read-only introspection of the bank for tests / docs / studio. */
export function describePadBank(): {
  styles: Readonly<Record<string, PadStyle>>;
  genreStyles: Readonly<Record<string, readonly string[]>>;
  barBeats: number;
  barDuration: number;
} {
  const bank = loadBank();
  const styles: Record<string, PadStyle> = {};
  for (const [name, style] of Object.entries(bank.index.styles)) styles[name] = style;
  const genreStyles: Record<string, readonly string[]> = {};
  for (const [g, s] of Object.entries(bank.index.genreStyles)) genreStyles[g] = [...s];
  return {
    styles,
    genreStyles,
    barBeats: bank.index.barBeats,
    barDuration: bank.index.barDuration,
  };
}
