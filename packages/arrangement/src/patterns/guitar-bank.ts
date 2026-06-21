// docs/54x — Legacy-derived guitar pattern bank (Lane A: per-string strums).
//
// The legacy GuitarPatternGeneratorClass loads a single
// `guitarPatterns.json` map (702 named patterns) and picks one by
// substring on the pattern key. For brain `genre === 'pop'` the legacy
// filter is `key.indexOf('Pop') !== -1` (33 patterns); we mirror that
// contract per canonical brain genre via `bank-index.json#genreStyles`.
//
// Each pattern is an array of bars; each bar is `{ notes: { "<beat>":
// [event, ...] } }`. Lane A only consumes `type: 'strum'` events from
// the bank — `virtualGuitarist` / `fretNoise` / etc events that appear
// in the broader bank rows are ignored by this loader (Lane B uses a
// different bank for the virtualGuitarist pattern, see
// `virtual-guitarist-bank.ts`).
//
// The strum events come with `chord: "C"` literals (the bank is keyed
// to C major). We override `chord` to the segment's actual chord at
// the event's beat position when lowering the pattern in `guitar.ts`.
// The engine ignores `noteData["chord"]` for strums anyway (see
// SequencerUtils.h::getStrumNotes — uses `currentChord` directly), but
// we keep the field meaningful for diagnostics + future use.
//
// Determinism contract: same `(rng, genre)` → identical pattern pick.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { GenreSchema, type Genre } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'guitar');

// ---- schemas ----

const BankIndexSchema = z.object({
  $schemaVersion: z.literal(2),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.unknown()).optional(),
  bankFile: z.string().min(1),
  // style name → substring marker(s) for the guitarPatterns.json name filter
  // (legacy GuitarPatternGeneratorClass.js switch).
  styleMarkers: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  // genre → list of guitar style names (legacy config.guitarPatterns[genre]).
  genreStyles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

// Bank pattern rows are mixed-shape (some 1-bar, some 2-bar; some carry
// only `strum` events, others also `virtualGuitarist` / `fretNoise`).
// We keep the bank as opaque `unknown[]` and let the consumer (Lane A's
// guitar.ts) filter the events it cares about. Validating each event
// here would couple Lane A to Lane B's `virtualGuitarist` schema.
const BarSchema = z
  .object({
    notes: z.record(z.string(), z.array(z.unknown())).optional(),
  })
  .passthrough();
const PatternSchema = z.array(BarSchema).min(1);
const BankFileSchema = z.record(z.string().min(1), PatternSchema);

// ---- public types ----

export interface GuitarBankPattern {
  readonly name: string;
  readonly bars: readonly { readonly notes: Readonly<Record<string, readonly unknown[]>> }[];
}

export interface GuitarBankSelection {
  /** The guitar style picked from the genre's `genreStyles` list. */
  readonly style: string;
  /** The substring marker(s) the chosen style maps to. */
  readonly markers: readonly string[];
  readonly candidateCount: number;
  readonly pattern: GuitarBankPattern;
}

// ---- loader ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/GuitarPatternGeneratorClass.js',
  extractedAt: '2026-06-08',
};

const BANK_FILE_META: DataAssetMeta = {
  filename: 'guitarPatterns.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/guitarPatterns.json',
  extractedAt: '2026-06-08',
};

interface ResolvedBank {
  readonly index: z.infer<typeof BankIndexSchema>;
  readonly patterns: ReadonlyMap<string, GuitarBankPattern>;
  /** sorted list of names — gives selection a stable iteration order
   *  across runs (Object.keys order is engine-defined but Node + V8
   *  preserve insertion order today; sort defensively). */
  readonly orderedNames: readonly string[];
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

  const bankPath = resolve(DATA_DIR, index.bankFile);
  let bankRaw: unknown;
  try {
    bankRaw = JSON.parse(readFileSync(bankPath, 'utf8'));
  } catch (err) {
    throw new DataAssetError(
      { ...BANK_FILE_META, filename: index.bankFile },
      `failed to load: ${(err as Error).message}`,
      err,
    );
  }
  const bankParse = BankFileSchema.safeParse(bankRaw);
  if (!bankParse.success) {
    throw new DataAssetError(
      { ...BANK_FILE_META, filename: index.bankFile },
      `bank file is malformed: ${bankParse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }

  const patterns = new Map<string, GuitarBankPattern>();
  const orderedNames: string[] = [];
  for (const [name, rawPattern] of Object.entries(bankParse.data)) {
    const bars = rawPattern.map((bar) => ({
      notes: Object.freeze(
        Object.fromEntries(
          Object.entries(bar.notes ?? {}).map(([beat, events]) => [
            beat,
            Object.freeze([...events]) as readonly unknown[],
          ]),
        ),
      ),
    }));
    patterns.set(name, { name, bars: Object.freeze(bars) });
    orderedNames.push(name);
  }
  orderedNames.sort();

  // Validate that every style referenced by a genre has a marker mapping.
  for (const [genre, styleList] of Object.entries(index.genreStyles)) {
    for (const style of styleList) {
      if (!index.styleMarkers[style]) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `genreStyles["${genre}"] references style "${style}" with no entry in styleMarkers`,
        );
      }
    }
  }

  cached = { index, patterns, orderedNames: Object.freeze(orderedNames) };
  return cached;
}

/** Test-only — drop the in-memory cache so a re-load re-reads disk. */
export function _resetGuitarBankCache(): void {
  cached = undefined;
}

// ---- selection ----

function stylesForGenre(genre: Genre): readonly string[] {
  const bank = loadBank();
  const styles = bank.index.genreStyles[genre];
  if (!styles || styles.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `no guitar style is mapped to genre "${genre}" — extend bank-index.json's genreStyles`,
    );
  }
  return styles;
}

function markersForStyle(style: string): readonly string[] {
  const bank = loadBank();
  const markers = bank.index.styleMarkers[style];
  if (!markers || markers.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `guitar style "${style}" has no markers in bank-index.json's styleMarkers`,
    );
  }
  return markers;
}

function filterPatternsByMarkers(
  bank: ResolvedBank,
  markers: readonly string[],
): GuitarBankPattern[] {
  const out: GuitarBankPattern[] = [];
  for (const name of bank.orderedNames) {
    for (const marker of markers) {
      if (name.indexOf(marker) !== -1) {
        out.push(bank.patterns.get(name)!);
        break;
      }
    }
  }
  return out;
}

/**
 * Deterministically pick one legacy guitar pattern for `genre`, using a
 * caller-owned `Rng` (the brain forks `ctx.rng.fork('patterns/guitar')`).
 *
 * Two-level selection, mirroring the legacy: first pick a guitar STYLE from
 * the genre's `genreStyles` list (legacy
 * `Tools.selectRandomly(config.guitarPatterns[genre])`), then filter
 * guitarPatterns.json by that style's substring marker(s) and pick one
 * pattern. A genre with a single style skips the style-pick draw (the
 * musical result is identical — there is only one style — and the stream
 * stays byte-stable for single-style genres like rock / latin).
 *
 * Throws `DataAssetError` on a non-canonical genre, an unmapped genre/style,
 * or an empty filtered candidate set.
 */
export function selectGuitarPattern(rng: Rng, genre: string): GuitarBankSelection {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  const bank = loadBank();
  const styles = stylesForGenre(parsed.data);
  const style = styles.length === 1 ? styles[0]! : rng.pick(styles);
  const markers = markersForStyle(style);
  const candidates = filterPatternsByMarkers(bank, markers);
  if (candidates.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `no patterns in guitarPatterns.json match markers [${markers.join(', ')}] for style "${style}" (genre "${genre}")`,
    );
  }
  const pattern = rng.pick(candidates);
  return {
    style,
    markers,
    candidateCount: candidates.length,
    pattern,
  };
}

/** Read-only introspection for tests / docs / studio. `genreCandidateCounts`
 *  reports the size of the UNION of every style's candidate set for the
 *  genre (the full pool a genre can draw from across its styles);
 *  `styleCandidateCounts` reports per-style filtered counts. */
export function describeGuitarBank(): {
  bankFile: string;
  totalPatterns: number;
  genreStyles: Readonly<Record<string, readonly string[]>>;
  genreCandidateCounts: Readonly<Record<string, number>>;
  styleCandidateCounts: Readonly<Record<string, number>>;
} {
  const bank = loadBank();
  const styleCounts: Record<string, number> = {};
  for (const [style, markers] of Object.entries(bank.index.styleMarkers)) {
    styleCounts[style] = filterPatternsByMarkers(bank, markers).length;
  }
  const genreCounts: Record<string, number> = {};
  const genreStyles: Record<string, readonly string[]> = {};
  for (const [genre, styles] of Object.entries(bank.index.genreStyles)) {
    genreStyles[genre] = [...styles];
    const union = new Set<string>();
    for (const style of styles) {
      for (const p of filterPatternsByMarkers(bank, bank.index.styleMarkers[style] ?? [])) {
        union.add(p.name);
      }
    }
    genreCounts[genre] = union.size;
  }
  return {
    bankFile: bank.index.bankFile,
    totalPatterns: bank.orderedNames.length,
    genreStyles,
    genreCandidateCounts: genreCounts,
    styleCandidateCounts: styleCounts,
  };
}
