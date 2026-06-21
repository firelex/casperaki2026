// Step 3 — imported legacy chord-progression bank.
//
// Loader + pure resolver. Does NOT integrate with `generateChords`, the
// orchestrator's RNG fork salts, or the brightPop slice's `pop_default`
// precedent — that wiring is a later step. Voice-leading is also deferred;
// `resolveBankEntry` is a straight numeral-by-numeral lookup against the
// Step-1 vocabulary, identical in math to `chords/index.ts`'s
// `romanToChordSymbol`.
//
// The legacy semantics this preserves are exactly:
//   - every entry is a `verse` candidate (`ChordsClass` runs the unfiltered
//     bank when picking a verse);
//   - `preChorus` candidates are entries the legacy code filtered by
//     `isLeadUpToChorus === true`;
//   - `chorus` candidates are entries the legacy code filtered by
//     `isChorus === true`.
//
// Determinism: `selectBankEntry` takes a caller-supplied `Rng`. No new
// fork salt is introduced here — the bank is consumed by code paths that
// don't yet exist; the eventual wiring step will choose the salt.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { degreePitchClass, type ParsedKey, type Rng } from '@casperaki/music-theory';
import { ChordSymbolSchema, type ChordSymbol } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import { loadChordsVocab, type ChordsVocab } from './data.js';

export type BankRole = 'verse' | 'preChorus' | 'chorus';

export interface BankEntry {
  readonly precedent: string;
  /** Home key the legacy bank stored the progression in. Kept for
   *  provenance — resolution is key-agnostic via the numeral vocabulary. */
  readonly sourceKey: string;
  readonly roles: readonly BankRole[];
  /** Outer = bars (4 for every imported entry); inner = chord per beat (4). */
  readonly bars: readonly (readonly string[])[];
}

// Sharps-only pitch-class names — same table `chords/index.ts` uses.
// Kept local to keep the bank resolver an isolated, read-only consumer
// of the Step-1 vocabulary.
const PITCH_CLASS_NAMES: readonly string[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data');

const BANK_META: DataAssetMeta = {
  filename: 'precedent-bank.json',
  legacyPath: 'casperaki2-engine-js/api/v1.0/services/classes/chords/chords.json',
  extractedAt: '2026-06-06',
};

const VALID_ROLES: ReadonlySet<BankRole> = new Set(['verse', 'preChorus', 'chorus']);

let cached: readonly BankEntry[] | undefined;

export function loadChordBank(): readonly BankEntry[] {
  if (cached) return cached;
  const path = resolve(DATA_DIR, BANK_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(BANK_META, `failed to load: ${(err as Error).message}`, err);
  }
  const obj = raw as { entries?: unknown };
  if (!obj || !Array.isArray(obj.entries))
    throw new DataAssetError(BANK_META, 'missing `entries` array');
  cached = obj.entries.map((e, i) => validateEntry(e, i));
  return cached;
}

function validateEntry(raw: unknown, idx: number): BankEntry {
  const e = raw as Partial<BankEntry>;
  if (typeof e.precedent !== 'string' || typeof e.sourceKey !== 'string')
    throw new DataAssetError(BANK_META, `entry #${idx}: missing precedent or sourceKey`);
  if (!Array.isArray(e.roles) || e.roles.length === 0 ||
      e.roles.some((r) => !VALID_ROLES.has(r as BankRole)))
    throw new DataAssetError(
      BANK_META,
      `entry #${idx} ("${e.precedent}"): roles must be non-empty subset of {verse,preChorus,chorus}`,
    );
  if (!Array.isArray(e.bars) || e.bars.length === 0 ||
      e.bars.some((b) => !Array.isArray(b) || b.length === 0 || b.some((c) => typeof c !== 'string')))
    throw new DataAssetError(
      BANK_META,
      `entry #${idx} ("${e.precedent}"): bars must be non-empty rectangle of numeral strings`,
    );
  return e as BankEntry;
}

/** Subset of `bank` whose `roles` include `role`. */
export function filterBankByRole(
  bank: readonly BankEntry[],
  role: BankRole,
): readonly BankEntry[] {
  return bank.filter((e) => e.roles.includes(role));
}

/** Deterministic uniform pick. The caller owns the `Rng` (fork salt,
 *  reproducibility); this function does not introduce a salt of its own. */
export function selectBankEntry(
  candidates: readonly BankEntry[],
  rng: Rng,
): BankEntry {
  if (candidates.length === 0)
    throw new Error('selectBankEntry: empty candidate list');
  return rng.pick(candidates);
}

/** Lower a bank entry's roman numerals to ChordSymbols against `key`. */
export function resolveBankEntry(
  entry: BankEntry,
  key: ParsedKey,
  vocab: ChordsVocab = loadChordsVocab(),
): readonly (readonly ChordSymbol[])[] {
  return entry.bars.map((bar) =>
    bar.map((numeral) => numeralToChordSymbol(numeral, vocab, key)),
  );
}

function numeralToChordSymbol(
  numeral: string,
  vocab: ChordsVocab,
  key: ParsedKey,
): ChordSymbol {
  const entry = vocab.romanNumerals[numeral];
  if (!entry)
    throw new Error(`resolveBankEntry: unknown roman numeral "${numeral}"`);
  let pc = degreePitchClass(key, entry.degree);
  if (entry.accidental) pc = (pc + entry.accidental + 12) % 12;
  const rootName = PITCH_CLASS_NAMES[pc]!;
  const suffix = vocab.qualitySymbols[entry.quality];
  if (suffix === undefined)
    throw new Error(`resolveBankEntry: unknown quality "${entry.quality}"`);
  return ChordSymbolSchema.parse(`${rootName}${suffix}`);
}

// Test-only: reset the in-process cache. Lets specs that mutate vocab in
// memory observe a fresh read; not exported from src/index.ts.
export function _resetBankCache(): void {
  cached = undefined;
}
