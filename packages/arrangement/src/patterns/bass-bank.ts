// Legacy-derived bass pattern bank — loader + selector.
//
// Bank shape mirrors the legacy SM (Simple/Manual) bass pattern files
// verbatim: each pattern is an array of `[position, duration, semitoneOffset]`
// triples covering two 4/4 bars (positions 0 .. 7.999), where:
//
//   - position is a 0-indexed beat within the 2-bar blueprint
//     (legacy `item[0]`).
//   - duration is in beats (legacy `item[1]`).
//   - semitoneOffset is added on top of the chord-root MIDI note in
//     `rootMidiOctave` (legacy `item[2]`; legacy code
//     `Tools.notes[Tools.getNoteIndexFull(getChordBaseNote(chord) + '2') + item[2]]`).
//
// Legacy source files (verbatim copies under data/patterns/bass/):
//   - balladSM.json     ← balladPatternsSM.json
//   - brightPopSM.json  ← brightPopPatternsSM.json
//   - edmHardSM.json    ← edmHardPatternsSM.json
//   - edmSoftSM.json    ← edmSoftPatternsSM.json
//   - latinSM.json      ← latinPatternsSM.json
//   - rockSM.json       ← rockPatternsSM.json
//   - urbanSM.json      ← urbanPatternsSM.json
//
// Plus `bank-index.json` (authored here) mapping every canonical brain
// genre → one or more SM style banks, declaring the rootMidiOctave the
// legacy SMBassPatternGeneratorClass hard-coded to "2".
//
// Per-genre dedicated big-MIDI banks (the `Library`/`EDM`/`HipHop`
// generators that consume the 3-4 MB `brightPopPatterns.json`,
// `organicVibesPatterns.json`, `EDMPatternsComplex.json`, etc.) are
// deferred to a follow-up PR (see docs/53v "Out of scope"). The SM
// slice is small, exhaustive across canonical genres, and was the
// legacy code path actually used when `style` ended in `SM`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { GenreSchema, type Genre } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'bass');

// ---- schemas ----

const HitTripleSchema = z
  .tuple([z.number().nonnegative(), z.number().positive(), z.number()])
  .rest(z.never());

const PatternSchema = z.array(HitTripleSchema).min(1);
const StyleBankSchema = z.array(PatternSchema).min(1);

const BankIndexSchema = z.object({
  $schemaVersion: z.literal(1),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.unknown()).optional(),
  rootMidiOctave: z.number().int().min(-1).max(8),
  styles: z.record(z.string().min(1), z.object({ file: z.string().min(1) })),
  genreStyles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

// ---- public types ----

/** One legacy SM-bank hit: position (beats), duration (beats), semitone offset from chord root. */
export type BassHit = readonly [position: number, duration: number, semitoneOffset: number];

/** One legacy SM-bank pattern: an ordered list of hits across the 2-bar blueprint. */
export type BassPattern = readonly BassHit[];

export interface BassStyleBank {
  readonly styleName: string;
  readonly patterns: readonly BassPattern[];
}

export interface BassBankSelection {
  readonly styleName: string;
  readonly patternIndex: number;
  readonly pattern: BassPattern;
  readonly patternBars: number;
  readonly rootMidiOctave: number;
}

// ---- loader ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/bassPatterns/{BassPatternGeneratorClass,SMBassPatternGeneratorClass}.js',
  extractedAt: '2026-06-06',
};

interface ResolvedBank {
  readonly index: z.infer<typeof BankIndexSchema>;
  readonly styles: ReadonlyMap<string, BassStyleBank>;
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

  const styles = new Map<string, BassStyleBank>();
  for (const [styleName, { file }] of Object.entries(index.styles)) {
    const styleMeta: DataAssetMeta = {
      filename: file,
      legacyPath: `casperaki2-engine-js/api/v1.0/services/classes/patterns/bassPatterns/elements/${file.replace('SM.json', 'PatternsSM.json')}`,
      extractedAt: '2026-06-06',
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8'));
    } catch (err) {
      throw new DataAssetError(
        styleMeta,
        `failed to load: ${(err as Error).message}`,
        err,
      );
    }
    const parsed = StyleBankSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DataAssetError(
        styleMeta,
        `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    styles.set(styleName, {
      styleName,
      patterns: parsed.data.map(
        (p) => Object.freeze(p.map((h) => Object.freeze([...h]) as BassHit)) as BassPattern,
      ),
    });
  }

  for (const [genre, styleList] of Object.entries(index.genreStyles)) {
    for (const styleName of styleList) {
      if (!styles.has(styleName)) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `genreStyles["${genre}"] references unknown style "${styleName}"`,
        );
      }
    }
  }

  cached = { index, styles };
  return cached;
}

/** Test-only — drop the in-memory cache so a re-load re-reads disk. */
export function _resetBassBankCache(): void {
  cached = undefined;
}

// ---- selection ----

const BEATS_PER_BAR_LEGACY = 4;

function patternBars(pattern: BassPattern): number {
  let lastBeatEnd = 0;
  for (const [position, duration] of pattern) {
    const end = position + duration;
    if (end > lastBeatEnd) lastBeatEnd = end;
  }
  // Round up to whole 4-beat bars. Every SM pattern in the legacy
  // bank covers exactly two bars, but compute defensively from the
  // hit data so a future bank with shorter / longer patterns slots
  // in without code changes.
  return Math.max(1, Math.ceil(lastBeatEnd / BEATS_PER_BAR_LEGACY));
}

function styleForGenre(genre: Genre): string {
  const bank = loadBank();
  const list = bank.index.genreStyles[genre];
  if (!list || list.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `no bass style is mapped to genre "${genre}" — extend bank-index.json's genreStyles or import a dedicated bank file under data/patterns/bass/`,
    );
  }
  return list[0]!;
}

/**
 * Deterministically pick one legacy SM bass pattern for `genre`, using a
 * caller-owned `Rng` (the brain forks `ctx.rng.fork('patterns/bass')`).
 *
 * Throws `DataAssetError` on a non-canonical genre, on an empty style
 * list, or on any bank-data malformation. Mirrors the contract of the
 * sibling drums selector (see drums-bank.ts).
 */
export function selectBassPattern(rng: Rng, genre: string): BassBankSelection {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  const bank = loadBank();
  const styleName = styleForGenre(parsed.data);
  const style = bank.styles.get(styleName)!;
  const patternIndex = rng.int(0, style.patterns.length - 1);
  const pattern = style.patterns[patternIndex]!;
  return {
    styleName,
    patternIndex,
    pattern,
    patternBars: patternBars(pattern),
    rootMidiOctave: bank.index.rootMidiOctave,
  };
}

/** Read-only introspection of the bank for tests / docs / studio. */
export function describeBassBank(): {
  styles: readonly string[];
  genreStyles: Readonly<Record<string, readonly string[]>>;
  rootMidiOctave: number;
  patternCount: Readonly<Record<string, number>>;
} {
  const bank = loadBank();
  const counts: Record<string, number> = {};
  for (const [name, style] of bank.styles) counts[name] = style.patterns.length;
  const genreStyles: Record<string, readonly string[]> = {};
  for (const [g, s] of Object.entries(bank.index.genreStyles)) genreStyles[g] = [...s];
  return {
    styles: [...bank.styles.keys()],
    genreStyles,
    rootMidiOctave: bank.index.rootMidiOctave,
    patternCount: counts,
  };
}

export const BASS_BEATS_PER_LEGACY_BAR = BEATS_PER_BAR_LEGACY;
