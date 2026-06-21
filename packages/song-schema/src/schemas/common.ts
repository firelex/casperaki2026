import { z } from 'zod';

// Bar-beat position key: integer or decimal string. The engine parses
// strings like "0.0", "2.5", "3.75". Stored as branded strings so two
// semantically-equal keys can be normalized at the canonical-serialization
// step rather than during parsing.
export const BarBeatSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/u, 'BarBeat must be a decimal-form numeric string')
  .brand<'BarBeat'>();
export type BarBeat = z.infer<typeof BarBeatSchema>;

// Note string: letter + optional accidental + octave (legacy uses lower or upper case)
export const NoteStringSchema = z
  .string()
  .regex(/^[A-Ga-g][#b]?-?\d+$/u, 'NoteString like "c2", "C#4", "Db-1"')
  .brand<'NoteString'>();
export type NoteString = z.infer<typeof NoteStringSchema>;

export const MidiNoteSchema = z.number().int().min(0).max(127).brand<'MidiNote'>();
export type MidiNote = z.infer<typeof MidiNoteSchema>;

// Chord symbol: loose regex matching engine's 40+ chord types.
// Permits root + accidental + optional modifiers/extensions.
export const ChordSymbolSchema = z
  .string()
  .regex(
    /^[A-G][#b]?(?:m|maj|min|dim|aug|sus[24]?|add\d+|[Mm]?\d+|6|7|9|11|13|m7b5|°|ø|\+|-)?(?:[a-zA-Z0-9#b]*)?(?:\/[A-G][#b]?)?$/u,
    'ChordSymbol must look like A, Am, Cmaj7, F#m7b5, G/B, …',
  )
  .brand<'ChordSymbol'>();
export type ChordSymbol = z.infer<typeof ChordSymbolSchema>;

export const BpmSchema = z.number().positive().brand<'Bpm'>();
export type Bpm = z.infer<typeof BpmSchema>;

/**
 * Canonical genre vocabulary the brain accepts.
 *
 * Derived from legacy `SongStructureClass.getSongStructure` (8 genres) and
 * cross-checked with the workbook's `MainStyleSchema` vocabulary
 * (`Audio Library Master File.xlsx`, see docs/53n-…). Workbook main styles
 * `8bit` and `gospel` exist in the catalog but have no structure rules in
 * the legacy code, so they are NOT canonical brain genres yet — they
 * remain catalog-only until per-style structure rules land. Workbook
 * additional-style `organicVibes` IS a canonical brain genre because the
 * legacy code accepts it.
 *
 * `Song.genre` on the canonical Song stays loose (`z.string().optional()`)
 * so historical or AI-only songs that predate this enum can round-trip
 * through `parseSong`. Generators / orchestrator constrain their input to
 * `GenreSchema` directly.
 */
export const GenreSchema = z.enum([
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'rock',
  'schlager',
  'urban',
]);
export type Genre = z.infer<typeof GenreSchema>;

export interface GenreTempoRange {
  readonly min: number;
  readonly max: number;
  readonly defaultBpm: number;
  readonly legacyStyle: string;
}

/**
 * Legacy-compatible tempo ranges for generated tracks.
 *
 * Ported from casperaki1
 * `api/v1.0/services/classes/songStructures/TempoClass.js`.
 * The ranges are inclusive because the legacy implementation uses
 * `base + Math.floor(Math.random() * count)`.
 */
export const GENRE_TEMPO_RANGES = {
  ballad: { min: 65, max: 80, defaultBpm: 75, legacyStyle: 'ballad' },
  brightPop: { min: 95, max: 129, defaultBpm: 120, legacyStyle: 'popTight' },
  edm: { min: 115, max: 150, defaultBpm: 128, legacyStyle: 'edm' },
  latin: { min: 90, max: 104, defaultBpm: 100, legacyStyle: 'latin' },
  organicVibes: { min: 75, max: 109, defaultBpm: 90, legacyStyle: 'popLoose' },
  rock: { min: 100, max: 129, defaultBpm: 120, legacyStyle: 'rock' },
  schlager: { min: 120, max: 129, defaultBpm: 120, legacyStyle: 'schlager' },
  urban: { min: 60, max: 100, defaultBpm: 90, legacyStyle: 'urban' },
} as const satisfies Record<Genre, GenreTempoRange>;

export const DEFAULT_BPM_BY_GENRE = Object.fromEntries(
  Object.entries(GENRE_TEMPO_RANGES).map(([genre, range]) => [genre, range.defaultBpm]),
) as Readonly<Record<Genre, number>>;

export function tempoRangeForGenre(genre: string): GenreTempoRange | undefined {
  return (GENRE_TEMPO_RANGES as Readonly<Record<string, GenreTempoRange>>)[genre];
}

export function isBpmInGenreTempoRange(genre: string, bpm: number): boolean {
  const range = tempoRangeForGenre(genre);
  return range !== undefined && Number.isInteger(bpm) && bpm >= range.min && bpm <= range.max;
}

export function formatGenreTempoRange(genre: string): string {
  const range = tempoRangeForGenre(genre);
  if (!range) return 'unknown genre';
  return `${range.min}-${range.max} bpm`;
}

export const LufsSchema = z.number().brand<'Lufs'>();
export type Lufs = z.infer<typeof LufsSchema>;

export const Sha256Schema = z
  .string()
  .regex(/^[A-Fa-f0-9]{64}$/u, 'Sha256 must be 64 hex chars')
  .brand<'Sha256'>();
export type Sha256 = z.infer<typeof Sha256Schema>;

// Either "c2" or numeric MIDI value (engine accepts both).
export const NoteRefSchema = z.union([NoteStringSchema, MidiNoteSchema]);
export type NoteRef = z.infer<typeof NoteRefSchema>;
