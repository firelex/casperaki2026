// Step 17e - dirty-rhyme / rhyme-control layer.
//
// Legacy source:
//   casperaki2-engine-js/api/v1.0/services/data/lyrics/templatePoetClass.js
//     lines 29-36   (load `dirtyRhymes.json` + flatten into a single list of
//                    interchangeable rhyme groups)
//     lines 218-304 (`_getRelevantPhoneme(word)` - the bucket function the
//                    rhyme-filter consults)
//   casperaki2-engine-js/api/v1.0/services/data/lyrics/database/dirtyRhymes.json
//     (the interchangeable-phoneme table; runtime variant - keyed by syllable
//      count 1 / 2)
//
// This module ports the bucket function and exposes a small typed API that
// the seed-phrase picker (and, later, the LLM lyric author) consume:
//
//   class RhymeIndex {
//     bucket(word): string | null
//     bucketOfLastWord(line): string | null
//     rhymesWith(a, b): boolean
//     candidatesIn(bucket, exclude?): string[]
//   }
//
// Determinism: pure over the input syllable bank + dirty-rhymes table; no
// rng draws of its own. Consumers (seed-phrase picker) keep using the
// existing `ctx.rng.fork('vocals')` stream.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import { loadSyllableBank, type SyllableBank } from './syllabify.js';

// ─── Data ────────────────────────────────────────────────────────────────

const DirtyRhymesBankSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string().optional(),
    $legacySource: z.string().optional(),
    $extractedAt: z.string().optional(),
    /** Keyed by syllable-count string ("1" / "2"). Each value is a list of
     *  rhyme groups; each group is a flat list of CMU phoneme tail strings
     *  treated as interchangeable for rhyme purposes. */
    groupsBySyllableCount: z.record(
      z.string().min(1),
      z.array(z.array(z.string().min(1)).min(1)).min(0),
    ),
  })
  .strict();

export type DirtyRhymesBank = z.infer<typeof DirtyRhymesBankSchema>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'lyrics');

const DIRTY_RHYMES_META: DataAssetMeta = {
  filename: 'dirtyRhymes.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/data/lyrics/database/dirtyRhymes.json',
  extractedAt: '2026-06-07',
};

let cachedBank: DirtyRhymesBank | undefined;

export function loadDirtyRhymesBank(): DirtyRhymesBank {
  if (cachedBank) return cachedBank;
  const path = resolve(DATA_DIR, DIRTY_RHYMES_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(
      DIRTY_RHYMES_META,
      `failed to load: ${(err as Error).message}`,
      err,
    );
  }
  const parsed = DirtyRhymesBankSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(
      DIRTY_RHYMES_META,
      `invalid bank shape: ${parsed.error.message}`,
    );
  }
  cachedBank = parsed.data;
  return cachedBank;
}

// ─── Bucket computation ──────────────────────────────────────────────────

// Legacy walks `syllables[word]['phonemes']` to compute the bucket. The
// trimmed brain syllable bank drops the redundant `phonemes` field
// (recoverable by flattening `phonemeSyllables`); we flatten on use.

function flattenPhonemes(phonemeSyllables: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const syl of phonemeSyllables) {
    for (const tok of syl.split(' ')) {
      if (tok.length > 0) out.push(tok);
    }
  }
  return out;
}

/** A CMU phoneme is a vowel iff its first letter is one of A E I O U.
 *  Mirrors the legacy `match(/[ aeiou ]/i)` test (which works on CMU strings
 *  like "AH0" / "OW1" / "ER0"). */
function isVowel(phoneme: string): boolean {
  const first = phoneme.charAt(0).toUpperCase();
  return first === 'A' || first === 'E' || first === 'I' || first === 'O' || first === 'U';
}

/** Mirror of `TemplatePoetClass._getRelevantPhoneme` (templatePoetClass.js
 *  lines 238-260). Picks how many trailing vowels to include in the rhyme
 *  tail based on the word's stress pattern. */
function numberOfVowelsPermitted(rhythm: readonly string[]): number {
  const last = rhythm[rhythm.length - 1];
  if (last !== '-') return 1;
  const secondLast = rhythm[rhythm.length - 2];
  if (rhythm.length > 1 && secondLast === '-') return 3;
  return 2;
}

/** Lightweight handle around the dirty-rhyme + syllable banks that exposes
 *  the rhyme-bucket API. Instantiated once per generator run (one bank,
 *  shared); the seed-phrase picker keeps a reference for the rhyme-line-2
 *  filter and the LLM authoring path (17f+) will use the same instance as
 *  a response validator. */
export class RhymeIndex {
  private readonly groups: readonly (readonly string[])[];
  /** Tail-phoneme -> bucket label (e.g. "EY1 Z" -> "Group 43"). */
  private readonly tailToBucket: Map<string, string>;

  constructor(
    private readonly syllables: SyllableBank,
    private readonly dirtyRhymes: DirtyRhymesBank,
  ) {
    // Legacy flattens the table into a single list of groups (without
    // distinguishing "1" / "2"). Bucket labels are assigned in the order
    // groups are visited (lyricist's `count` variable - templatePoetClass.js
    // line 284-294); we mirror that order so future cross-checks against
    // the legacy bucket strings stay consistent. The legacy code's exact
    // numeric label depends on a small JS quirk (iterating Object.entries
    // on a string yields one extra step per top-level key); the bucket
    // EQUALITY semantics are identical regardless of the label value, so
    // for the brain port we assign labels strictly by group index.
    const groups: (readonly string[])[] = [];
    const tailToBucket = new Map<string, string>();
    const keys = Object.keys(dirtyRhymes.groupsBySyllableCount).sort();
    for (const k of keys) {
      const groupsForK = dirtyRhymes.groupsBySyllableCount[k]!;
      for (const group of groupsForK) {
        const label = `Group ${groups.length + 1}`;
        groups.push(group);
        for (const tail of group) {
          // First-wins: a tail string that recurs in multiple groups (the
          // legacy table has a few overlaps - e.g. "AH1 P" appears in
          // both the AH1/AO1 group and the AW1 group) is assigned to the
          // earliest group, matching the legacy `break` on first match.
          if (!tailToBucket.has(tail)) tailToBucket.set(tail, label);
        }
      }
    }
    this.groups = groups;
    this.tailToBucket = tailToBucket;
  }

  /** Returns the rhyme-bucket key for `word`, or `null` if the word is not
   *  in the syllable bank (legacy returned `false` in that case).
   *
   *  If the rhyme tail does not appear in any dirty-rhyme group, the raw
   *  tail string is returned (e.g. "EY1") so two words with the same raw
   *  tail still rhyme even if the group table doesn't index them. This
   *  matches the legacy fall-through: `phoneme = relevantPhonemes.reverse().join(' ')`
   *  is the return value if the inner group-replacement `if` never fires. */
  bucket(word: string): string | null {
    const sanitized = sanitizeWord(word);
    if (!sanitized) return null;
    const entry = this.syllables.entries[sanitized];
    if (!entry) return null;
    const phonemes = flattenPhonemes(entry.phonemeSyllables);
    const permitted = numberOfVowelsPermitted(entry.rhythm);
    const tail: string[] = [];
    let vowels = 0;
    for (let i = phonemes.length - 1; i >= 0; i--) {
      const p = phonemes[i]!;
      tail.push(p);
      if (isVowel(p)) {
        vowels++;
        if (vowels === permitted) break;
      }
    }
    const tailStr = tail.reverse().join(' ');
    if (tailStr.length === 0) return null;
    return this.tailToBucket.get(tailStr) ?? tailStr;
  }

  /** Convenience wrapper: derive the bucket from the last word in a phrase.
   *  `line` may be either a raw string of words or a pre-split list of
   *  tokens; trailing punctuation / case differences are stripped via the
   *  same sanitizer the syllable-attach pass uses. */
  bucketOfLastWord(line: string | readonly string[]): string | null {
    const tokens = typeof line === 'string'
      ? line.split(/\s+/u).filter((t) => t.length > 0)
      : [...line];
    while (tokens.length > 0) {
      const last = tokens.pop()!;
      const b = this.bucket(last);
      if (b !== null) return b;
    }
    return null;
  }

  /** True iff `a` and `b` resolve to the same rhyme bucket. Returns `false`
   *  if either word is missing from the syllable bank (matches the legacy
   *  filter behaviour: a missing-bucket candidate never passes the rhyme
   *  predicate). */
  rhymesWith(a: string, b: string): boolean {
    const ba = this.bucket(a);
    if (ba === null) return false;
    const bb = this.bucket(b);
    if (bb === null) return false;
    return ba === bb;
  }

  /** Returns every word in the SYLLABLE BANK whose bucket equals `bucket`.
   *  Used by the LLM retry validator (17f+) to surface alternative rhyme
   *  candidates when the model's first response fails the filter; the
   *  17e seed-phrase picker filters its own phrase pool directly so it
   *  does not call this. */
  candidatesIn(bucket: string, exclude: readonly string[] = []): readonly string[] {
    const excludeSet = new Set(exclude.map((w) => sanitizeWord(w)).filter((w): w is string => w !== null));
    const out: string[] = [];
    for (const word of Object.keys(this.syllables.entries)) {
      if (excludeSet.has(word)) continue;
      if (this.bucket(word) === bucket) out.push(word);
    }
    return out;
  }

  /** Number of dirty-rhyme groups loaded - exposed for diagnostics + tests
   *  pinning that the bank loaded cleanly. */
  get groupCount(): number {
    return this.groups.length;
  }
}

function sanitizeWord(word: string): string | null {
  const cleaned = word.replace(/[^A-Za-z']/gu, '').toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

let cachedIndex: RhymeIndex | undefined;

/** Returns the process-wide RhymeIndex singleton. Both banks load
 *  lazily / cache; the index itself caches because it precomputes the
 *  tail -> bucket lookup map. */
export function getRhymeIndex(): RhymeIndex {
  if (cachedIndex) return cachedIndex;
  cachedIndex = new RhymeIndex(loadSyllableBank(), loadDirtyRhymesBank());
  return cachedIndex;
}
