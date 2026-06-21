// Legacy-derived keys (piano) pattern bank — loader, style registry + selectors.
//
// docs/58 sound-parity. The bank manifest (bank-index.json) is the single
// per-genre style dispatch source (mirroring drums/bank-index.json). Each
// canonical genre maps to one-or-more style names; the keys generator
// (keys.ts) picks one via `resolveKeysStyle` and routes by the style's
// `kind`:
//   - kind 'chordPattern' (file-backed, emits `chord` events):
//       * format 'hitGroups'     → chordsStraight.json (legacy
//         ChordsPianoPatternGeneratorClass classic substyle — hit-group
//         pools + length categories resolved per-hit via rng).
//       * format 'absHitTriples' → edmHousePiano.json (legacy
//         EDMHousePianoPatternGeneratorClass — a list of [absHit, duration,
//         layer] triples; pick one pattern of < 12 triples and emit each as
//         a chord at hit%4 in bar floor(hit/4), duration clamped to 0.5).
//   - kind 'algo' (chordsMixed / arpeggio) → handled by keys-algo.ts.
//   - kind 'ezKeys' (library / altLibrary) → handled by piano-bank.ts
//     (EZKeys patterns.json; emits `noteRelative` events).
//
// Legacy genre→style table is `config.json#defaultStyleMappings.pianoPatterns`.
// chordsStraight / chordsMixed / arpeggio are legacy `freestyle`-only styles;
// they ship as available styles (exercised by unit tests) but no canonical
// rebuild genre routes to them by default.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { GenreSchema, type Genre } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import { isKeysAlgoStyleName, type KeysAlgoStyleName } from './keys-algo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'keys');

// ---- schemas ----

const LengthCategorySchema = z.enum(['short', 'medium', 'long']);

const KeysHitGroupSchema = z
  .object({
    beats: z.array(z.number().min(0).max(8)).min(1),
    duration: z.union([z.number().positive(), LengthCategorySchema]),
  })
  .strict();

const KeysPatternSchema = z
  .object({
    id: z.string().min(1),
    legacySource: z.string().optional(),
    bars: z.array(z.array(KeysHitGroupSchema)).min(1),
  })
  .strict();

const KeysHitGroupBankSchema = z
  .object({
    $description: z.string().optional(),
    patterns: z.array(KeysPatternSchema).min(1),
  })
  .passthrough();

// edmHousePiano.json — array of patterns; each pattern is a list of
// `[absHit, duration, layer]` triples (legacy EDMHousePianoPatterns.json).
// The `layer` channel (1/2) is ignored by the legacy generator.
const EdmHouseTripleSchema = z.array(z.number()).min(2);
const EdmHousePatternSchema = z.array(EdmHouseTripleSchema).min(1);
const EdmHouseBankSchema = z.array(EdmHousePatternSchema).min(1);

const LengthDurationsSchema = z.object({
  short: z.array(z.number().positive()).min(1),
  medium: z.array(z.number().positive()).min(1),
  long: z.array(z.number().positive()).min(1),
});

const StyleEntrySchema = z.union([
  z.object({
    kind: z.literal('chordPattern'),
    format: z.enum(['hitGroups', 'absHitTriples']),
    file: z.string().min(1),
  }),
  z.object({ kind: z.literal('algo') }),
  z.object({ kind: z.literal('ezKeys'), library: z.string().min(1) }),
]);

const BankIndexSchema = z.object({
  $schemaVersion: z.literal(2),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.unknown()).optional(),
  lengthDurations: LengthDurationsSchema,
  styles: z.record(z.string().min(1), StyleEntrySchema),
  genreStyles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

// ---- public types ----

export type KeysLengthCategory = z.infer<typeof LengthCategorySchema>;
export type KeysHitGroup = Readonly<{
  beats: readonly number[];
  duration: number | KeysLengthCategory;
}>;
export type KeysPattern = Readonly<{
  id: string;
  legacySource?: string;
  bars: ReadonlyArray<readonly KeysHitGroup[]>;
}>;
export type KeysLengthDurations = Readonly<Record<KeysLengthCategory, readonly number[]>>;

export interface KeysStyleBank {
  readonly styleName: string;
  readonly patterns: readonly KeysPattern[];
}

export interface KeysBankSelection {
  readonly styleName: string;
  readonly patternIndex: number;
  readonly pattern: KeysPattern;
  readonly patternBars: number;
  readonly lengthDurations: KeysLengthDurations;
}

/** One deterministic chord slot expanded from an edmHousePiano triple. */
export interface EdmHouseChordSlot {
  readonly bar: number;
  readonly beat: number;
  readonly duration: number;
}
export interface EdmHousePianoSelection {
  readonly styleName: string;
  readonly patternIndex: number;
  readonly slots: readonly EdmHouseChordSlot[];
  readonly patternBars: number;
}

export type KeysStyleKind = 'chordPattern' | 'algo' | 'ezKeys';

/** Resolved style descriptor for one genre pick. */
export type ResolvedKeysStyle =
  | { readonly kind: 'chordPattern'; readonly styleName: string; readonly format: 'hitGroups' | 'absHitTriples' }
  | { readonly kind: 'algo'; readonly styleName: string; readonly algoName: KeysAlgoStyleName }
  | { readonly kind: 'ezKeys'; readonly styleName: string; readonly library: string };

// ---- loader ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki1/api/v1.0/services/classes/patterns/pianoPatterns/PianoPatternGeneratorClass.js (defaultStyleMappings.pianoPatterns)',
  extractedAt: '2026-06-14',
};

type ResolvedStyle =
  | { kind: 'chordPattern'; format: 'hitGroups'; patterns: KeysPattern[] }
  | { kind: 'chordPattern'; format: 'absHitTriples'; patterns: ReadonlyArray<readonly EdmHouseChordSlot[]> }
  | { kind: 'algo'; algoName: KeysAlgoStyleName }
  | { kind: 'ezKeys'; library: string };

interface ResolvedBank {
  readonly index: z.infer<typeof BankIndexSchema>;
  readonly styles: ReadonlyMap<string, ResolvedStyle>;
}

let cached: ResolvedBank | undefined;

function loadJson(meta: DataAssetMeta): unknown {
  try {
    return JSON.parse(readFileSync(resolve(DATA_DIR, meta.filename), 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
}

function freezeHitGroupPatterns(raw: z.infer<typeof KeysHitGroupBankSchema>): KeysPattern[] {
  return raw.patterns.map(
    (p) =>
      Object.freeze({
        id: p.id,
        legacySource: p.legacySource,
        bars: Object.freeze(
          p.bars.map((bar) =>
            Object.freeze(
              bar.map(
                (g) =>
                  Object.freeze({
                    beats: Object.freeze([...g.beats]) as readonly number[],
                    duration: g.duration,
                  }) as KeysHitGroup,
              ),
            ),
          ),
        ) as ReadonlyArray<readonly KeysHitGroup[]>,
      }) as KeysPattern,
  );
}

// Legacy EDMHousePianoPatternGeneratorClass: select among patterns with
// `< 12` triples; per triple emit a chord at hit=absHit%4 in bar
// floor(absHit/4), duration = min(duration, 0.5).
function expandEdmHousePatterns(
  raw: z.infer<typeof EdmHouseBankSchema>,
): ReadonlyArray<readonly EdmHouseChordSlot[]> {
  return raw
    .filter((pattern) => pattern.length < 12)
    .map((pattern) =>
      Object.freeze(
        pattern.map((triple) => {
          const absHit = triple[0]!;
          const duration = triple[1]!;
          return Object.freeze({
            bar: Math.floor(absHit / 4),
            beat: absHit % 4,
            duration: Math.min(duration, 0.5),
          }) as EdmHouseChordSlot;
        }),
      ),
    );
}

function loadBank(): ResolvedBank {
  if (cached) return cached;
  const indexRaw = loadJson(BANK_INDEX_META);
  const indexParse = BankIndexSchema.safeParse(indexRaw);
  if (!indexParse.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `manifest is malformed: ${indexParse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const index = indexParse.data;

  const styles = new Map<string, ResolvedStyle>();
  for (const [styleName, entry] of Object.entries(index.styles)) {
    if (entry.kind === 'algo') {
      if (!isKeysAlgoStyleName(styleName)) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `style "${styleName}" is kind 'algo' but no keys-algo generator is named "${styleName}"`,
        );
      }
      styles.set(styleName, { kind: 'algo', algoName: styleName });
      continue;
    }
    if (entry.kind === 'ezKeys') {
      styles.set(styleName, { kind: 'ezKeys', library: entry.library });
      continue;
    }
    // chordPattern — file-backed.
    const fileMeta: DataAssetMeta = {
      filename: entry.file,
      legacyPath:
        'casperaki1/api/v1.0/services/classes/patterns/pianoPatterns/',
      extractedAt: '2026-06-14',
    };
    const raw = loadJson(fileMeta);
    if (entry.format === 'hitGroups') {
      const parsed = KeysHitGroupBankSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DataAssetError(
          fileMeta,
          `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        );
      }
      styles.set(styleName, {
        kind: 'chordPattern',
        format: 'hitGroups',
        patterns: freezeHitGroupPatterns(parsed.data),
      });
    } else {
      const parsed = EdmHouseBankSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DataAssetError(
          fileMeta,
          `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        );
      }
      const expanded = expandEdmHousePatterns(parsed.data);
      if (expanded.length === 0) {
        throw new DataAssetError(
          fileMeta,
          `style "${styleName}" has no selectable patterns (all >= 12 triples)`,
        );
      }
      styles.set(styleName, {
        kind: 'chordPattern',
        format: 'absHitTriples',
        patterns: expanded,
      });
    }
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
export function _resetKeysBankCache(): void {
  cached = undefined;
}

// ---- selection ----

const BEATS_PER_BAR_LEGACY = 4;

function patternBars(pattern: KeysPattern): number {
  return Math.max(1, pattern.bars.length);
}

function assertCanonicalGenre(genre: string): Genre {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  return parsed.data;
}

function frozenLengthDurations(index: z.infer<typeof BankIndexSchema>): KeysLengthDurations {
  return Object.freeze({
    short: Object.freeze([...index.lengthDurations.short]) as readonly number[],
    medium: Object.freeze([...index.lengthDurations.medium]) as readonly number[],
    long: Object.freeze([...index.lengthDurations.long]) as readonly number[],
  }) as KeysLengthDurations;
}

/**
 * Resolve the keys style for `genre` — picks one style name from the
 * manifest's `genreStyles[genre]` via the caller-owned `Rng` (legacy
 * `Tools.selectRandomly(config.defaultStyleMappings.pianoPatterns[genre])`).
 * Throws `DataAssetError` on a non-canonical genre or an empty mapping.
 */
export function resolveKeysStyle(rng: Rng, genre: string): ResolvedKeysStyle {
  const canonical = assertCanonicalGenre(genre);
  const bank = loadBank();
  const list = bank.index.genreStyles[canonical];
  if (!list || list.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `no keys style is mapped to genre "${genre}" — extend bank-index.json's genreStyles`,
    );
  }
  const styleName = rng.pick(list);
  const style = bank.styles.get(styleName)!;
  switch (style.kind) {
    case 'chordPattern':
      return { kind: 'chordPattern', styleName, format: style.format };
    case 'algo':
      return { kind: 'algo', styleName, algoName: style.algoName };
    case 'ezKeys':
      return { kind: 'ezKeys', styleName, library: style.library };
  }
}

function getChordPatternStyle(
  styleName: string,
): Extract<ResolvedStyle, { kind: 'chordPattern' }> {
  const bank = loadBank();
  const style = bank.styles.get(styleName);
  if (!style || style.kind !== 'chordPattern') {
    throw new DataAssetError(
      BANK_INDEX_META,
      `style "${styleName}" is not a loaded chord-pattern style`,
    );
  }
  return style;
}

/**
 * Deterministically pick one `chordsStraight` (hit-group) pattern. This is
 * the bank's reference chord-comping selector. `genre` is validated for
 * canonical-ness only (the chordsStraight bank is genre-independent).
 *
 * Throws `DataAssetError` on a non-canonical genre.
 */
export function selectKeysPattern(rng: Rng, genre: string): KeysBankSelection {
  assertCanonicalGenre(genre);
  return selectChordsStraightPattern(rng);
}

/** Pick one hit-group (`chordsStraight`) pattern. */
export function selectChordsStraightPattern(rng: Rng): KeysBankSelection {
  const style = getChordPatternStyle('chordsStraight');
  if (style.format !== 'hitGroups') {
    throw new DataAssetError(BANK_INDEX_META, `style "chordsStraight" is not hitGroups`);
  }
  const bank = loadBank();
  const patternIndex = rng.int(0, style.patterns.length - 1);
  const pattern = style.patterns[patternIndex]!;
  return {
    styleName: 'chordsStraight',
    patternIndex,
    pattern,
    patternBars: patternBars(pattern),
    lengthDurations: frozenLengthDurations(bank.index),
  };
}

/** Pick one edmHousePiano pattern, expanded to deterministic chord slots. */
export function selectEdmHousePianoPattern(rng: Rng): EdmHousePianoSelection {
  const style = getChordPatternStyle('edmHousePiano');
  if (style.format !== 'absHitTriples') {
    throw new DataAssetError(BANK_INDEX_META, `style "edmHousePiano" is not absHitTriples`);
  }
  const patternIndex = rng.int(0, style.patterns.length - 1);
  const slots = style.patterns[patternIndex]!;
  let maxBar = 0;
  for (const s of slots) if (s.bar > maxBar) maxBar = s.bar;
  return {
    styleName: 'edmHousePiano',
    patternIndex,
    slots,
    patternBars: Math.max(1, maxBar + 1),
  };
}

/** Read-only introspection of the bank for tests / docs / studio. */
export function describeKeysBank(): {
  styles: readonly string[];
  genreStyles: Readonly<Record<string, readonly string[]>>;
  lengthDurations: KeysLengthDurations;
  patternCount: Readonly<Record<string, number>>;
} {
  const bank = loadBank();
  const counts: Record<string, number> = {};
  for (const [name, style] of bank.styles) {
    if (style.kind === 'chordPattern') counts[name] = style.patterns.length;
  }
  const genreStyles: Record<string, readonly string[]> = {};
  for (const [g, s] of Object.entries(bank.index.genreStyles)) genreStyles[g] = [...s];
  return {
    styles: [...bank.styles.keys()],
    genreStyles,
    lengthDurations: frozenLengthDurations(bank.index),
    patternCount: counts,
  };
}

export const KEYS_BEATS_PER_LEGACY_BAR = BEATS_PER_BAR_LEGACY;
