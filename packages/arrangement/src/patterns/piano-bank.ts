// docs/55a — Piano pattern bank loader + LibraryPianoPattern port.
//
// Ports the smallest faithful subset of
// casperaki2-engine-js/api/v1.0/services/classes/patterns/pianoPatterns/LibraryPianoPatternGeneratorClass.js
// that unlocks the deferred synth styles (54z §"What 54z deliberately
// does NOT do"):
//   - EDMSynthsPlucked (style='edmSynthsPluckedLibrary')
//   - EDMSynthsStabs   (style='edmSynthsStabsLibrary')
//   - synths/synthsPlucked lane (legacy forces
//     style='edmSynthsPluckedLibrary' on this lowLevel)
//
// Out of scope: `library` (EZ Keys piano bank, 16 MB), `altLibrary`
// (keyboardMonophonic / keyboardPolyphonic — used only by
// organicVibes / schlager / brightPop's `keyboardMonophonicRhythmic`
// for leadSynthsAnalog), and every other piano style (EDM /
// chordsStraight / chordsMixed / arpeggio / playful) — each needs a
// dedicated sub-generator port. See LEGACY_PROVENANCE.md.
//
// Bank shape (per legacy):
//   { name, bpm, leftHandNotes: {<absoluteHit>: [{position, duration},...]},
//                rightHandNotes: {<absoluteHit>: [{position, duration},...]} }
//
// Expansion pipeline (per legacy LibraryPianoPatternGeneratorClass:55-178):
//   1. Compute genre `durationAddOn` (ballad/rock=+1, urban=+0.5, else 0).
//   2. Compute bpm `adjustmentFactor` from pattern.bpm vs song.bpm.
//   3. `monophonic` mode: emit only the FIRST note per right-hand hit;
//      NO octave-centering.
//   4. Polyphonic mode: emit every note from BOTH hands. Apply
//      octave-centering: adjustment = -12 * round(averagePosition/12).
//   5. `stabs` mode: clamp every duration to 0.25 (the legacy
//      Math.max(0.25, Math.min(0.25, x)) double-clamp).
//   6. Per-hit emit a `type:'noteRelative'` event with
//      `distanceFromMiddleC = position + adjustment`, `chord:'C'`
//      (engine ignores this — uses currentChord), duration.
//
// Multi-bar patterns: every bank row spans up to 4 bars (hits go up
// to ~15.75). The brain's per-bar expansion places each hit in the
// bar `Math.floor(hit*adjustmentFactor/4.0)` at `hit*factor%4.0`.
// When the brain's segment is longer than the pattern's bar count,
// the expanded pattern is REPEATED — same as the legacy renderer's
// segment-extension behaviour.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'piano');

// ---- schemas ----

const NoteSchema = z.object({
  position: z.number().int(),
  duration: z.number().nonnegative(),
});
const HandNotesSchema = z.record(z.string(), z.array(NoteSchema));

const PatternSchema = z.object({
  name: z.string().min(1),
  bpm: z.union([z.number().positive(), z.string()]),
  leftHandNotes: HandNotesSchema.optional().default({}),
  rightHandNotes: HandNotesSchema.optional().default({}),
});

const BankFileSchema = z.record(z.string(), z.array(PatternSchema));

// docs/56c follow-on — schema v2 adds optional `bucketBy: 'genre'` for
// multi-bucket libraries (EZKeys `library` + `altLibrary` carry one
// bucket per genre). Single-bucket libraries keep the original
// `bucket` field. Exactly one of `bucket` / `bucketBy` must be set.
const BankIndexSchema = z.object({
  $schemaVersion: z.union([z.literal(1), z.literal(2)]),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.unknown()).optional(),
  libraries: z.record(
    z.string().min(1),
    z.union([
      z.object({ file: z.string().min(1), bucket: z.string().min(1) }),
      z.object({ file: z.string().min(1), bucketBy: z.literal('genre') }),
    ]),
  ),
});

// ---- public types ----

export type PianoLibrary =
  | 'edmSynthsPluckedLibrary'
  | 'edmSynthsStabsLibrary'
  // docs/56c follow-on — EZKeys patterns.json (per-genre) +
  // altPatterns.json (single `pop` bucket).
  | 'library'
  | 'altLibrary';

export interface PianoBankPattern {
  readonly library: PianoLibrary;
  readonly name: string;
  readonly bpm: number;
  readonly leftHandNotes: Readonly<Record<string, readonly { position: number; duration: number }[]>>;
  readonly rightHandNotes: Readonly<Record<string, readonly { position: number; duration: number }[]>>;
}

export interface PianoBankSelection {
  readonly library: PianoLibrary;
  readonly bucket: string;
  readonly candidateCount: number;
  readonly pattern: PianoBankPattern;
}

/** One brain-emittable noteRelative event from the expanded pattern. */
export interface ExpandedNoteRelativeEvent {
  /** 0-indexed bar within the segment (post-bpm-scale). */
  readonly bar: number;
  /** Beat within the bar in [0, 4). */
  readonly beat: number;
  /** Signed semitones from middle C (post octave-centering adjustment). */
  readonly distanceFromMiddleC: number;
  /** Per-step duration in beats. */
  readonly duration: number;
}

export interface ExpandedPattern {
  /** All expanded events, flat. Caller buckets by `bar` then `beat`. */
  readonly events: readonly ExpandedNoteRelativeEvent[];
  /** Pattern length in bars after the bpm scale. */
  readonly barCount: number;
}

// ---- loader ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/pianoPatterns/LibraryPianoPatternGeneratorClass.js',
  extractedAt: '2026-06-08',
};

/** docs/56c follow-on — a library may be single-bucket (one pool keyed
 *  by a fixed bucket name) or multi-bucket (keyed `bucketBy:'genre'`,
 *  one pool per genre — used by EZKeys library/altLibrary). */
type ResolvedLibrary =
  | { kind: 'single'; bucket: string; patterns: PianoBankPattern[] }
  | { kind: 'multi'; bucketBy: 'genre'; pools: ReadonlyMap<string, PianoBankPattern[]> };

interface ResolvedBank {
  readonly libraries: ReadonlyMap<PianoLibrary, ResolvedLibrary>;
}

let cached: ResolvedBank | undefined;

function loadRaw<T>(meta: DataAssetMeta, schema: z.ZodSchema<T>): T {
  const path = resolve(DATA_DIR, meta.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
  const parse = schema.safeParse(raw);
  if (!parse.success) {
    throw new DataAssetError(
      meta,
      `bank is malformed: ${parse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parse.data;
}

function freezePatterns(
  libName: PianoLibrary,
  raw: readonly z.input<typeof PatternSchema>[],
): PianoBankPattern[] {
  return raw.map((p) => ({
    library: libName,
    name: p.name,
    bpm: typeof p.bpm === 'number' ? p.bpm : Number.parseFloat(p.bpm),
    leftHandNotes: Object.freeze(
      Object.fromEntries(
        Object.entries(p.leftHandNotes ?? {}).map(([beat, notes]) => [
          beat,
          Object.freeze([...notes]),
        ]),
      ),
    ),
    rightHandNotes: Object.freeze(
      Object.fromEntries(
        Object.entries(p.rightHandNotes ?? {}).map(([beat, notes]) => [
          beat,
          Object.freeze([...notes]),
        ]),
      ),
    ),
  }));
}

function loadBank(): ResolvedBank {
  if (cached) return cached;
  const index = loadRaw(BANK_INDEX_META, BankIndexSchema);
  const libraries = new Map<PianoLibrary, ResolvedLibrary>();
  for (const [libName, libSpec] of Object.entries(index.libraries)) {
    const file = libSpec.file;
    const fileMeta: DataAssetMeta = {
      filename: file,
      legacyPath: `casperaki2-engine-js/api/v1.0/services/classes/patterns/pianoPatterns/${file}`,
      extractedAt: '2026-06-08',
    };
    const raw = loadRaw(fileMeta, BankFileSchema);
    if ('bucket' in libSpec) {
      const bucketPatterns = raw[libSpec.bucket];
      if (!bucketPatterns || bucketPatterns.length === 0) {
        throw new DataAssetError(
          fileMeta,
          `bucket "${libSpec.bucket}" empty in ${file} — library "${libName}" has no patterns`,
        );
      }
      libraries.set(libName as PianoLibrary, {
        kind: 'single',
        bucket: libSpec.bucket,
        patterns: freezePatterns(libName as PianoLibrary, bucketPatterns),
      });
    } else {
      // bucketBy: 'genre' — load every non-empty bucket as its own pool.
      const pools = new Map<string, PianoBankPattern[]>();
      for (const [bucket, patterns] of Object.entries(raw)) {
        if (!patterns || patterns.length === 0) continue;
        pools.set(bucket, freezePatterns(libName as PianoLibrary, patterns));
      }
      if (pools.size === 0) {
        throw new DataAssetError(
          fileMeta,
          `multi-bucket library "${libName}" has no non-empty pools in ${file}`,
        );
      }
      libraries.set(libName as PianoLibrary, {
        kind: 'multi',
        bucketBy: 'genre',
        pools,
      });
    }
  }
  cached = { libraries };
  return cached;
}

/** Test-only — drop the in-memory cache so a re-load re-reads disk. */
export function _resetPianoBankCache(): void {
  cached = undefined;
}

// ---- selection ----

/**
 * Deterministically pick one piano-library pattern.
 *
 * For single-bucket libraries (edmSynthsPluckedLibrary /
 * edmSynthsStabsLibrary / altLibrary), the `genre` argument is
 * ignored. For multi-bucket libraries (currently `library` —
 * EZKeys patterns.json with per-genre pools), `genre` selects the
 * pool. A genre with no pool throws `DataAssetError` — call sites
 * must check coverage via {@link describePianoBank} first or
 * route to a different library.
 *
 * Throws `DataAssetError` on an unknown library OR a multi-bucket
 * library missing the requested genre pool.
 */
export function selectPianoLibraryPattern(
  rng: Rng,
  library: PianoLibrary,
  genre?: string,
): PianoBankSelection {
  const bank = loadBank();
  const lib = bank.libraries.get(library);
  if (!lib) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `unknown piano library "${library}" — known: ${[...bank.libraries.keys()].join(', ')}`,
    );
  }
  if (lib.kind === 'single') {
    const pattern = rng.pick(lib.patterns);
    return {
      library,
      bucket: lib.bucket,
      candidateCount: lib.patterns.length,
      pattern,
    };
  }
  // Multi-bucket — `genre` is required.
  if (!genre) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `library "${library}" is multi-bucket (bucketBy=${lib.bucketBy}); selectPianoLibraryPattern requires a genre argument`,
    );
  }
  const pool = lib.pools.get(genre);
  if (!pool || pool.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `multi-bucket library "${library}" has no pool for genre "${genre}" — available: ${[...lib.pools.keys()].join(', ')}`,
    );
  }
  const pattern = rng.pick(pool);
  return {
    library,
    bucket: genre,
    candidateCount: pool.length,
    pattern,
  };
}

/** docs/56c follow-on — report whether a multi-bucket library has a
 *  non-empty pool for the given genre. Used by callers (keys.ts /
 *  synths.ts) that want to fall back to a different library when a
 *  genre's bucket is absent. Returns true for every (library, genre)
 *  pair on single-bucket libraries because their genre input is
 *  ignored. */
export function pianoLibraryHasGenrePool(
  library: PianoLibrary,
  genre: string,
): boolean {
  const bank = loadBank();
  const lib = bank.libraries.get(library);
  if (!lib) return false;
  if (lib.kind === 'single') return lib.patterns.length > 0;
  const pool = lib.pools.get(genre);
  return pool !== undefined && pool.length > 0;
}

// ---- expansion ----

interface ExpandOptions {
  /** Song bpm (drives the pattern.bpm vs songBpm scaling). */
  readonly songBpm: number;
  /** When true: emit only first note per right-hand hit; NO octave-centering. */
  readonly monophonic?: boolean;
  /** When true: clamp every emitted duration to 0.25 (the legacy double-clamp). */
  readonly stabs?: boolean;
  /** Genre name (drives durationAddOn). */
  readonly genre: string;
}

function durationAddOnForGenre(genre: string): number {
  if (genre === 'ballad' || genre === 'rock') return 1;
  if (genre === 'urban') return 0.5;
  return 0;
}

function adjustmentFactorForBpm(patternBpm: number, songBpm: number): number {
  // Mirrors LibraryPianoPatternGeneratorClass.js:68-86.
  const bpms = [patternBpm / 2, patternBpm, patternBpm * 2];
  if (songBpm <= bpms[1]) {
    if (songBpm - bpms[0] < bpms[1] - songBpm) return 2;
  } else {
    if (songBpm - bpms[1] > bpms[2] - songBpm) return 0.5;
  }
  return 1;
}

/**
 * Expand a picked piano-library pattern into noteRelative events,
 * grouped by bar then beat. Pure port of
 * LibraryPianoPatternGeneratorClass.js:55-178.
 */
export function expandPianoLibraryPattern(
  pattern: PianoBankPattern,
  options: ExpandOptions,
): ExpandedPattern {
  const durationAddOn = durationAddOnForGenre(options.genre);
  const adjustmentFactor = adjustmentFactorForBpm(pattern.bpm, options.songBpm);

  const events: ExpandedNoteRelativeEvent[] = [];

  const clampStabs = (duration: number): number => {
    if (!options.stabs) return duration;
    // Legacy double-clamp Math.max(0.25, Math.min(0.25, duration)) ≡ 0.25.
    return 0.25;
  };

  if (options.monophonic) {
    // Right-hand only; first note per hit; no octave-centering.
    const hits = Object.keys(pattern.rightHandNotes)
      .map((k) => ({ key: k, hit: Number.parseFloat(k) }))
      .filter((e) => Number.isFinite(e.hit))
      .sort((a, b) => a.hit - b.hit);
    for (const { key, hit } of hits) {
      const notes = pattern.rightHandNotes[key];
      if (!notes || notes.length === 0) continue;
      const note = notes[0]!;
      const absBeat = hit * adjustmentFactor;
      const bar = Math.floor(absBeat / 4);
      const beat = absBeat % 4;
      events.push({
        bar,
        beat,
        distanceFromMiddleC: note.position,
        duration: clampStabs(note.duration + durationAddOn),
      });
    }
  } else {
    // Polyphonic: walk both hands; compute octave-centering adjustment.
    let totalPosition = 0;
    let count = 0;
    for (const hand of ['leftHandNotes', 'rightHandNotes'] as const) {
      for (const notes of Object.values(pattern[hand])) {
        for (const n of notes) {
          totalPosition += n.position;
          count++;
        }
      }
    }
    const adjustment =
      count === 0 ? 0 : -12 * Math.round(totalPosition / count / 12);

    for (const hand of ['leftHandNotes', 'rightHandNotes'] as const) {
      const hits = Object.keys(pattern[hand])
        .map((k) => ({ key: k, hit: Number.parseFloat(k) }))
        .filter((e) => Number.isFinite(e.hit))
        .sort((a, b) => a.hit - b.hit);
      for (const { key, hit } of hits) {
        const notes = pattern[hand][key];
        if (!notes) continue;
        const absBeat = hit * adjustmentFactor;
        const bar = Math.floor(absBeat / 4);
        const beat = absBeat % 4;
        for (const note of notes) {
          events.push({
            bar,
            beat,
            distanceFromMiddleC: note.position + adjustment,
            duration: clampStabs(note.duration + durationAddOn),
          });
        }
      }
    }
  }

  const barCount = Math.max(
    1,
    events.reduce((max, e) => (e.bar > max ? e.bar : max), 0) + 1,
  );
  // Stable sort by bar then beat — keeps the brain's per-bar emission
  // deterministic across runs.
  events.sort((a, b) => a.bar - b.bar || a.beat - b.beat);
  return { events: Object.freeze(events), barCount };
}

/** Read-only introspection for tests / docs / studio.
 *  Multi-bucket libraries report `bucket: '<bucketBy>'` and a
 *  patternCount that sums every pool. Pool sizes per bucket are
 *  available via the optional `pools` map. */
export function describePianoBank(): {
  libraries: Readonly<Record<string, {
    bucket: string;
    patternCount: number;
    pools?: Readonly<Record<string, number>>;
  }>>;
} {
  const bank = loadBank();
  const out: Record<string, { bucket: string; patternCount: number; pools?: Record<string, number> }> = {};
  for (const [name, lib] of bank.libraries) {
    if (lib.kind === 'single') {
      out[name] = { bucket: lib.bucket, patternCount: lib.patterns.length };
    } else {
      const pools: Record<string, number> = {};
      let total = 0;
      for (const [bucket, patterns] of lib.pools) {
        pools[bucket] = patterns.length;
        total += patterns.length;
      }
      out[name] = { bucket: `bucketBy:${lib.bucketBy}`, patternCount: total, pools };
    }
  }
  return { libraries: out };
}
