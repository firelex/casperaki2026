// Step 17b — vocal precedent banks + merge port.
//
// Legacy source:
//   - casperaki2-engine-js/api/v1.0/services/classes/vocals/MelodyClass.js
//     lines 984-1096  → `_getMergedRhythmicAndMelodicPrecedentHelper`
//     lines 1098-1666 → `_getMergedRhythmicAndMelodicPrecedent`
//     lines 765-983   → `_getClosestNoteForBeat`
//   - casperaki2-engine-js/api/v1.0/services/classes/vocals/offline/patterns/
//     mlDataRaw - *.json (10 banks)
//
// Each precedent in a bank is `{ id, properties, melody, chords }`:
//
//   properties: { name, originalKey, key, tempo, busyness, type, start, end,
//                 lowestNote, highestNote, medianNote }
//     - `start` / `end` are bar offsets within the precedent. Most banks are
//       8-bar (`start = 0`, `end = 8`); a few (drLuke + schlager) carry
//       `start = 1` "lead-in" variants and `end = 4 | 9`.
//     - `type` is the segment lane the precedent was authored for; the
//       dispatcher does NOT filter on it (it picks the bank by genre +
//       segmentType in the brain and trusts every entry in the bank).
//
//   melody: { "<beat>": [ { note, midi, duration } ] }
//     - Beats are 1/4 of a bar (the legacy convention — 4 beats per bar).
//     - The bank is sparse: only beats with a note appear.
//
//   chords: { "<beat>": { chord } }
//     - One entry per integer beat (dense, `end * 4` entries).
//
// Brain port surface:
//   - `loadPrecedentBank(id)`        → cached, Zod-validated, returns
//                                       deep-frozen entries.
//   - `selectMergedPrecedent(args)`  → faithful port of
//                                       `_getMergedRhythmicAndMelodicPrecedent`.
//     Returns the merged precedent object plus the post-`buildTree` MIDI
//     sequence (so callers don't have to re-walk the melody dict). RNG is
//     scoped — selection consumes 2-3 `rng.pick` draws per call (rhythmic
//     bank pick + melodic bank pick + optional retries; see RNG contract
//     in docs/53ae).
//   - A rule may list several melodic banks, among them the hooks bank
//     (our own complete melodies); see "several melodic banks, hooks"
//     below. Single-bank rules keep the legacy path and draws.
//
// Determinism: every randomness draw goes through `Rng.pick` (legacy
// `Tools.selectRandomly`). `_buildTree` itself is deterministic given its
// input and is reused via the existing `buildContour` export.
//
// Preserved legacy oddities (deliberate, documented):
//   1. Legacy `selectRandomly` of `precedents.filter(...)` is replicated
//      verbatim — the slow / fast tempo slice (`-5` entries) included.
//   2. Legacy's `dispatcher` does NOT filter by `precedent.properties.type`
//      against the requested `segmentType`. The bank `schlager` carries
//      `Pre-chorus` / `Verse` / `Chorus` / `Intro` / `Bridge` entries; the
//      chorus dispatcher picks `schlager` regardless of the entry's
//      `properties.type`. This is a known imperfection in the legacy
//      code; we replicate it.
//   3. Legacy's helper short-circuit (precedent shorter than desired →
//      double up melody+chords by shifting beats `+length*4`) is ported
//      verbatim. The helper mutates a shallow clone of the picked
//      precedent — the port deep-clones for safety.
//   4. Legacy's `_getClosestNoteForBeat` does a backward sweep on the
//      melodic precedent to pick a substitute pitch, then forward, then
//      falls back to the closest chord-tone via `Tools.findClosestChordNote`.
//      The brain port surfaces a minimal version: backward sweep through
//      the melodic precedent's pre-tracked note grid, then forward; the
//      closest-chord-tone fallback is implemented via `parseChord` +
//      `nearestPitchInChord` because the brain has no Tools.notesABCMap
//      equivalent yet. This is the "minimal port" of the helper called out
//      in the docs as acceptable for the 17b slice.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { parseChord } from '@casperaki/music-theory';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import { buildContour } from './contour.js';
import { MIN_NOTE } from './range.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'vocals', 'precedents');

// ---- precedent schema ----

// Legacy beats are stringified floats ("0.0", "0.5", "2.75").
const BeatStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/u);

const MelodyNoteSchema = z
  .object({
    note: z.string().min(1),
    midi: z.number().int(),
    duration: z.number().positive(),
  })
  .passthrough();

const ChordEntrySchema = z
  .object({ chord: z.string().min(1) })
  .passthrough();

const PrecedentPropertiesSchema = z
  .object({
    name: z.string().optional(),
    originalKey: z.string().optional(),
    key: z.string().optional(),
    tempo: z.union([z.string(), z.number()]).optional(),
    busyness: z.number().optional(),
    type: z.string().optional(),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    lowestNote: z.number().optional(),
    highestNote: z.number().optional(),
    medianNote: z.number().optional(),
  })
  .passthrough();

const PrecedentSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    properties: PrecedentPropertiesSchema,
    melody: z.record(BeatStringSchema, z.array(MelodyNoteSchema).min(1)),
    chords: z.record(BeatStringSchema, ChordEntrySchema),
  })
  .passthrough();

const BankSchema = z.array(PrecedentSchema).min(1);

export type Precedent = z.infer<typeof PrecedentSchema>;
export type PrecedentMelodyNote = z.infer<typeof MelodyNoteSchema>;

// ---- bank index schema ----

const GenreSegmentRuleSchema = z
  .object({
    // A single bank id (every legacy rule) or a list of bank ids whose union is the melodic pool (see
    // `selectFromMelodicList`). The two forms take different code paths: a single id is the legacy port, untouched.
    melodic: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    rhythmic: z.string().min(1).optional(),
    rhythmicTempoSplit: z.number().positive().optional(),
    maxNote: z.number().int().positive().optional(),
  })
  .strict();

const BankIndexSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string().optional(),
    $legacySource: z.record(z.string()).optional(),
    $dispatcherNotes: z.record(z.string()).optional(),
    banks: z.record(z.string(), z.object({ file: z.string().min(1) }).strict()),
    // The hooks bank (our own complete melodies, docs/superpowers/specs/2026-11-24-hook-library-design.md) and the
    // share of hook picks used whole (the rest are mixed with a second hook).
    hooks: z
      .object({
        bank: z.string().min(1),
        wholeShare: z.number().min(0).max(1),
        // Highest note (legacy register) for placing hooks, per section type. Used for hooks only, whole and
        // mixed, in place of the rule's maxNote (which keeps applying to legacy picks).
        maxNote: z.record(z.string(), z.number().int().positive()),
      })
      .strict()
      .optional(),
    genres: z.record(
      z.string(),
      z.record(z.string(), GenreSegmentRuleSchema),
    ),
  })
  .strict();

export type BankIndex = z.infer<typeof BankIndexSchema>;
export type GenreSegmentRule = z.infer<typeof GenreSegmentRuleSchema>;

/** Rules the schema cannot express: the hooks bank exists, is only ever named in a `melodic` list (so a
 *  single-string rule always means the legacy path), never as a rhythmic bank, and lists name known banks once. */
function checkBankIndex(index: BankIndex): string[] {
  const problems: string[] = [];
  const hooksBank = index.hooks?.bank;
  if (hooksBank !== undefined && !index.banks[hooksBank]) {
    problems.push(`hooks.bank "${hooksBank}" is not listed under banks`);
  }
  for (const [genre, rules] of Object.entries(index.genres)) {
    for (const [segmentType, rule] of Object.entries(rules)) {
      const where = `genres.${genre}.${segmentType}`;
      if (typeof rule.melodic === 'string') {
        if (rule.melodic === hooksBank) {
          problems.push(`${where}: the hooks bank must be given in a list ("melodic": ["${hooksBank}", ...])`);
        }
      } else {
        if (new Set(rule.melodic).size !== rule.melodic.length) {
          problems.push(`${where}: melodic lists a bank twice`);
        }
        for (const id of rule.melodic) {
          if (!index.banks[id]) problems.push(`${where}: melodic bank "${id}" is not listed under banks`);
        }
      }
      if (hooksBank !== undefined && rule.rhythmic === hooksBank) {
        problems.push(`${where}: the hooks bank cannot be a rhythmic bank (a hook brings its own rhythm)`);
      }
    }
  }
  return problems;
}

// ---- cached loaders ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/vocals/MelodyClass.js:1098-1665 (_getMergedRhythmicAndMelodicPrecedent)',
  extractedAt: '2026-06-07',
};

let cachedIndex: BankIndex | undefined;
const cachedBanks = new Map<string, readonly Precedent[]>();

/** Test-only replacement for the files under data/vocals/precedents: `index` stands for bank-index.json and
 *  `files` maps a bank file name (as the index's `banks.<id>.file` gives it) to its parsed JSON. Both go through
 *  the same validation as the real files. Production code never calls this; `undefined` restores the real files. */
export interface PrecedentTestData {
  readonly index: unknown;
  readonly files: Readonly<Record<string, unknown>>;
}
let testData: PrecedentTestData | undefined;

export function setPrecedentDataForTests(data: PrecedentTestData | undefined): void {
  testData = data;
  cachedIndex = undefined;
  cachedBanks.clear();
}

function readPrecedentJson(filename: string): unknown {
  if (testData) {
    if (!(filename in testData.files)) throw new Error(`test data has no file "${filename}"`);
    return testData.files[filename];
  }
  return JSON.parse(readFileSync(resolve(DATA_DIR, filename), 'utf8'));
}

export function loadBankIndex(): BankIndex {
  if (cachedIndex) return cachedIndex;
  let raw: unknown;
  try {
    raw = testData ? testData.index : readPrecedentJson(BANK_INDEX_META.filename);
  } catch (err) {
    throw new DataAssetError(BANK_INDEX_META, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = BankIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(BANK_INDEX_META, `invalid bank index: ${parsed.error.message}`);
  }
  const problems = checkBankIndex(parsed.data);
  if (problems.length > 0) {
    throw new DataAssetError(BANK_INDEX_META, `invalid bank index: ${problems.join('; ')}`);
  }
  cachedIndex = parsed.data;
  return cachedIndex;
}

export function loadPrecedentBank(bankId: string): readonly Precedent[] {
  const cached = cachedBanks.get(bankId);
  if (cached) return cached;
  const index = loadBankIndex();
  const entry = index.banks[bankId];
  if (!entry) {
    throw new DataAssetError(BANK_INDEX_META, `unknown bank id "${bankId}"`);
  }
  const meta: DataAssetMeta = {
    filename: entry.file,
    legacyPath: `casperaki2-engine-js/api/v1.0/services/classes/vocals/offline/patterns/${entry.file}`,
    extractedAt: '2026-06-07',
  };
  let raw: unknown;
  try {
    raw = readPrecedentJson(entry.file);
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = BankSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(meta, `invalid bank shape: ${parsed.error.message}`);
  }
  const frozen = Object.freeze(parsed.data) as readonly Precedent[];
  cachedBanks.set(bankId, frozen);
  return frozen;
}

// ---- dispatcher ----

export interface DispatchInputs {
  readonly genre: string;
  readonly segmentType: string;
  readonly tempo: number;
}

export interface DispatchResult {
  readonly melodicBank: readonly Precedent[];
  readonly rhythmicBank: readonly Precedent[];
  readonly mixPrecedents: boolean;
  readonly maxNote: number | undefined;
}

const DEFAULT_MAX_NOTE = 59; // legacy MelodyClass.maxNote

function sliceByTempo(
  bank: readonly Precedent[],
  tempo: number,
  threshold: number,
): readonly Precedent[] {
  // Legacy idiom (lines 1131-1140, 1166-1173, 1199-1208, 1260-1269, 1297-1308):
  //   if (tempo >= threshold) bank = bank.slice(0, bank.length - 5)
  //   else                     bank = bank.slice(5)
  // Picks the "fast 5" or "slow 5" subset based on which side of the
  // tempo cutoff we're on. If the bank has ≤5 entries the slice degenerates
  // — we replicate that legacy behaviour rather than guard against it.
  return tempo >= threshold ? bank.slice(0, bank.length - 5) : bank.slice(5);
}

function lookupRule(inputs: DispatchInputs): GenreSegmentRule | undefined {
  const index = loadBankIndex();
  const genreRules = index.genres[inputs.genre];
  if (!genreRules) {
    throw new DataAssetError(BANK_INDEX_META, `no dispatcher entry for genre "${inputs.genre}"`);
  }
  return genreRules[inputs.segmentType];
}

/** The legacy dispatch of one rule with one melodic bank. */
function dispatchRule(rule: GenreSegmentRule, melodicBankId: string, tempo: number): DispatchResult {
  const melodicBank = loadPrecedentBank(melodicBankId);
  let rhythmicBank: readonly Precedent[] | undefined;
  if (rule.rhythmic) {
    rhythmicBank = loadPrecedentBank(rule.rhythmic);
    if (rule.rhythmicTempoSplit !== undefined) {
      rhythmicBank = sliceByTempo(rhythmicBank, tempo, rule.rhythmicTempoSplit);
    }
  }
  const mixPrecedents = rhythmicBank !== undefined;
  // Legacy fallback (line 1404): `rhythmicPrecedents = rhythmicStructurePrecedents ? rhythmicStructurePrecedents : localPrecedents;`
  const rhythmic = rhythmicBank ?? melodicBank;
  return {
    melodicBank,
    rhythmicBank: rhythmic,
    mixPrecedents,
    maxNote: rule.maxNote,
  };
}

/** Returns `undefined` when the dispatcher has no precedent for the given
 *  segment (e.g. "intro" / "outro" / "break"); the caller skips those.
 *  Serves single-bank rules only; a rule listing several melodic banks is
 *  resolved inside `selectMergedPrecedent` (its bank choice draws from the rng). */
export function dispatchPrecedent(inputs: DispatchInputs): DispatchResult | undefined {
  const rule = lookupRule(inputs);
  if (!rule) return undefined;
  if (typeof rule.melodic !== 'string') {
    throw new Error(
      `vocals/precedents: ${inputs.genre}/${inputs.segmentType} lists several melodic banks (${rule.melodic.join(', ')}); dispatchPrecedent serves single-bank rules only — use selectMergedPrecedent`,
    );
  }
  return dispatchRule(rule, rule.melodic, inputs.tempo);
}

// ---- helper: pick + double + normalize ----

interface HelperParams {
  readonly desiredPatternLength: number; // in bars
}

function deepClone<T>(value: T): T {
  // Precedents go through `_getMergedRhythmicAndMelodicPrecedentHelper`
  // which mutates `properties.start / properties.end` and may copy keys
  // around in `melody` / `chords`. Deep-clone so the cached bank stays
  // immutable.
  return JSON.parse(JSON.stringify(value)) as T;
}

function getBeatString(beat: number): string {
  // Mirrors legacy `_getBeatString`: integer beats get ".0" appended.
  // Floats keep their natural form (legacy uses no extra rounding here —
  // the JSON beat keys are already in `<int>.<25|5|75>` form so
  // `parseFloat(x).toString()` is faithful enough).
  const s = String(beat);
  return s.indexOf('.') === -1 ? `${s}.0` : s;
}

function pickHelperPrecedent(
  precedents: readonly Precedent[],
  params: HelperParams,
  rng: Rng,
): Precedent {
  // Port of `_getMergedRhythmicAndMelodicPrecedentHelper` lines 984-1096.
  const desired = params.desiredPatternLength;

  // 1. Try to pick a precedent whose pattern length is within [desired/2..desired].
  const inWindow = precedents.filter((e) => desired >= e.properties.end - e.properties.start);
  let picked: Precedent;
  if (inWindow.length !== 0) {
    const candidates = precedents.filter(
      (e) =>
        desired >= e.properties.end - e.properties.start &&
        desired <= 2 * (e.properties.end - e.properties.start),
    );
    // The legacy code calls `selectRandomly` on the doubly-filtered list,
    // not on `inWindow`. If the inner filter is empty, legacy's
    // `selectRandomly` would crash; the brain port surfaces a typed error
    // so callers see it as a data issue, not a generic crash.
    if (candidates.length === 0) {
      throw new Error(
        `vocals/precedents: no in-window candidate for desiredPatternLength=${desired}`,
      );
    }
    picked = deepClone(rng.pick(candidates));
  } else {
    // 2. Every pattern is longer than what we need — shrink the picked
    //    one by floor(desired/4)*4 bars from the start.
    picked = deepClone(rng.pick(precedents));
    picked.properties.start = picked.properties.end - Math.floor(desired / 4) * 4;
  }

  // 3. If the precedent is still less than half the desired length, double
  //    it up by copying every melody + chord entry shifted by `length * 4`
  //    beats.
  if ((picked.properties.end - picked.properties.start) * 2 <= desired) {
    const length = picked.properties.end - picked.properties.start;
    picked.properties.end += length;

    const newMelody: Record<string, PrecedentMelodyNote[]> = { ...picked.melody };
    for (const beatString of Object.keys(picked.melody)) {
      const newBeat = parseFloat(beatString) + length * 4;
      newMelody[getBeatString(newBeat)] = picked.melody[beatString]!;
    }
    picked.melody = newMelody;

    const newChords: Record<string, { chord: string }> = { ...picked.chords };
    for (const beatString of Object.keys(picked.chords)) {
      const newBeat = parseFloat(beatString) + length * 4;
      newChords[getBeatString(newBeat)] = picked.chords[beatString]!;
    }
    picked.chords = newChords;
  }

  // 4. If still less than half the desired length, give up (legacy throws).
  if ((picked.properties.end - picked.properties.start) * 2 <= desired) {
    throw new Error(
      `vocals/precedents: unable to grow precedent to desiredPatternLength=${desired}`,
    );
  }

  // 5. Normalize: drop any beats before `start * 4`, shift remaining beats
  //    so the precedent starts at beat 0.
  if (picked.properties.start > 0) {
    const offset = picked.properties.start * 4;
    const newMelody: Record<string, PrecedentMelodyNote[]> = {};
    for (const beatString of Object.keys(picked.melody)) {
      const beat = parseFloat(beatString);
      if (beat < offset) continue;
      newMelody[getBeatString(beat - offset)] = picked.melody[beatString]!;
    }
    const newChords: Record<string, { chord: string }> = {};
    for (const beatString of Object.keys(picked.chords)) {
      const beat = parseFloat(beatString);
      if (beat < offset) continue;
      newChords[getBeatString(beat - offset)] = picked.chords[beatString]!;
    }
    picked.melody = newMelody;
    picked.chords = newChords;
    picked.properties.end = picked.properties.end - picked.properties.start;
    picked.properties.start = 0;
  }

  return picked;
}

// ---- _getClosestNoteForBeat (minimal port) ----

interface ClosestNoteResult {
  readonly midi: number;
}

/** Port of `MelodyClass._getClosestNoteForBeat` (lines 765-983). The brain
 *  port uses `parseChord` for the closest-chord-tone fallback because the
 *  brain has no `Tools.notesABCMap` equivalent yet. */
function getClosestNoteForBeat(
  targetBeatForRhythmicPrecedent: number,
  targetBeatForMelodicPrecedent: number,
  rhythmicPrecedent: Precedent,
  melodicPrecedent: Precedent,
  lastMidi: number,
): ClosestNoteResult | undefined {
  const melodyBeats = Object.keys(melodicPrecedent.melody);
  if (melodyBeats.length === 0) return undefined;
  const firstBeat = parseFloat(melodyBeats[0]!);
  const lastBeat = parseFloat(melodyBeats[melodyBeats.length - 1]!);
  const currentChordBeat = Math.floor(targetBeatForMelodicPrecedent);
  const currentChordEntry = melodicPrecedent.chords[getBeatString(currentChordBeat)];
  if (!currentChordEntry) return undefined;
  const currentChord = currentChordEntry.chord;

  let nextChordBeat = currentChordBeat;
  let nextChord = currentChord;
  const plusOne = melodicPrecedent.chords[getBeatString(currentChordBeat + 1)];
  const plusTwo = melodicPrecedent.chords[getBeatString(currentChordBeat + 2)];
  if (plusOne && plusOne.chord !== currentChord) {
    nextChordBeat = currentChordBeat + 1;
    nextChord = plusOne.chord;
  } else if (plusTwo && plusTwo.chord !== currentChord) {
    nextChordBeat = currentChordBeat + 2;
    nextChord = plusTwo.chord;
  }

  const rhythmicEntry = rhythmicPrecedent.melody[getBeatString(targetBeatForRhythmicPrecedent)];
  if (!rhythmicEntry) return undefined;
  const noteEndTime =
    Math.floor(targetBeatForRhythmicPrecedent + rhythmicEntry[0]!.duration) -
    targetBeatForRhythmicPrecedent +
    targetBeatForMelodicPrecedent;
  const chordChange = currentChord !== nextChord && noteEndTime >= nextChordBeat;

  let melodyMidi: number | undefined;
  // Backward pass: walk back up to 2 beats (in 0.25 steps), looking for the
  // first beat that has a melody note in the precedent.
  for (let j = targetBeatForMelodicPrecedent; j >= firstBeat && j >= currentChordBeat - 2; j -= 0.25) {
    const entry = melodicPrecedent.melody[getBeatString(j)];
    if (entry) {
      melodyMidi = entry[0]!.midi;
      break;
    }
  }
  let foundOnForward = false;
  if (melodyMidi === undefined || chordChange) {
    for (let j = targetBeatForMelodicPrecedent; j <= lastBeat && j < currentChordBeat + 2; j += 0.25) {
      const entry = melodicPrecedent.melody[getBeatString(j)];
      if (entry) {
        melodyMidi = entry[0]!.midi;
        foundOnForward = true;
        break;
      }
    }
  }
  if (melodyMidi === undefined && lastMidi !== -1) {
    melodyMidi = nearestChordToneMidi(chordChange ? nextChord : currentChord, lastMidi);
  }
  if (!foundOnForward && chordChange && lastMidi !== -1) {
    melodyMidi = nearestChordToneMidi(nextChord, lastMidi);
  }
  if (melodyMidi === undefined) return undefined;
  return { midi: melodyMidi };
}

function nearestChordToneMidi(chordSymbol: string, lastMidi: number): number {
  // Minimal stand-in for `Tools.findClosestChordNote`: use parseChord to
  // grab the chord's pitch class set, then pick the nearest MIDI value
  // (preserving octave choice driven by `lastMidi`).
  const chord = parseChord(chordSymbol);
  const chordPcs = new Set<number>();
  chordPcs.add(chord.root);
  // parseChord returns at least the root; brain port currently doesn't
  // expose the full chord tone set so we approximate with the triad
  // built off the root. This is faithful enough for the closest-note
  // adjustment because the contour BFS re-pins the final pitch anyway.
  const isMinor = /m(?!aj)/u.test(chordSymbol);
  chordPcs.add((chord.root + (isMinor ? 3 : 4)) % 12);
  chordPcs.add((chord.root + 7) % 12);

  let bestMidi = lastMidi;
  let bestDist = Infinity;
  for (let m = lastMidi - 12; m <= lastMidi + 12; m++) {
    const pc = ((m % 12) + 12) % 12;
    if (!chordPcs.has(pc)) continue;
    const dist = Math.abs(m - lastMidi);
    if (dist < bestDist) {
      bestDist = dist;
      bestMidi = m;
    }
  }
  return bestMidi;
}

// ---- merge port ----

export interface MergeInputs {
  readonly desiredPatternLength: number;
  readonly segmentType: string;
  readonly genre: string;
  readonly tempo: number;
  readonly rng: Rng;
}

export interface MergedPrecedent {
  readonly rhythmicPrecedentId: string | number;
  readonly rhythmicPrecedentName: string | undefined;
  readonly melodicPrecedentId: string | number;
  readonly melodicPrecedentName: string | undefined;
  readonly properties: {
    readonly start: number;
    readonly end: number;
    readonly maxNote: number;
    readonly melodyFirstNote: number;
    readonly melodyLastNote: number;
    readonly melodyMinNote: number;
    readonly melodyMaxNote: number;
  };
  /** Beats keyed by stringified beat offset (within the precedent, NOT
   *  the segment). One entry per rhythmic precedent beat. */
  readonly melody: Readonly<Record<string, readonly { midi: number; duration: number }[]>>;
  /** Mirrors legacy: chords lifted from the melodic precedent. */
  readonly chords: Readonly<Record<string, { readonly chord: string }>>;
}

const MAX_MERGE_RETRIES = 6; // legacy: `if (safety++ > 5) throw`

/** Faithful port of `_getMergedRhythmicAndMelodicPrecedent`. Returns
 *  `undefined` for segment types the dispatcher has no entry for. A rule
 *  whose `melodic` is a list of banks goes through `selectFromMelodicList`;
 *  a rule with a single melodic bank (every legacy rule) takes the legacy
 *  path below, with the same rng draws as before lists existed. */
export function selectMergedPrecedent(inputs: MergeInputs): MergedPrecedent | undefined {
  const rule = lookupRule(inputs);
  if (!rule) return undefined;
  if (typeof rule.melodic !== 'string') return selectFromMelodicList(rule, rule.melodic, inputs);
  return mergeLegacy(dispatchRule(rule, rule.melodic, inputs.tempo), inputs);
}

/** The legacy selection + merge for one dispatched melodic bank. */
function mergeLegacy(dispatch: DispatchResult, inputs: MergeInputs): MergedPrecedent {
  const maxNote = dispatch.maxNote ?? DEFAULT_MAX_NOTE;

  const rng = inputs.rng;
  const rhythmicPrecedent = pickHelperPrecedent(
    dispatch.rhythmicBank,
    { desiredPatternLength: inputs.desiredPatternLength },
    rng,
  );

  // Legacy melodic-bank filter (lines 1462-1471): drop entries that match
  // the rhythmic precedent's name+type so we don't end up draping the
  // same melody over itself.
  const melodicCandidates = dispatch.melodicBank.filter(
    (e) =>
      e.properties.name !== rhythmicPrecedent.properties.name ||
      e.properties.type !== rhythmicPrecedent.properties.type,
  );
  if (melodicCandidates.length === 0) {
    throw new Error(
      `vocals/precedents: no melodic candidates for ${inputs.genre}/${inputs.segmentType}`,
    );
  }

  let safety = 0;
  while (true) {
    let melodicPrecedent: Precedent;
    if (dispatch.mixPrecedents) {
      melodicPrecedent = pickHelperPrecedent(
        melodicCandidates,
        { desiredPatternLength: inputs.desiredPatternLength },
        rng,
      );
    } else {
      melodicPrecedent = rhythmicPrecedent;
    }

    const draped = drapeAndPlace(rhythmicPrecedent, melodicPrecedent, maxNote, undefined);
    if (draped.ok) return draped.merged;
    // Retry — bank pick may have produced an empty merge under
    // segment-type / chord-grid drift, or a melody the contour cannot place.
    if (safety++ > MAX_MERGE_RETRIES) {
      throw new Error(
        `vocals/precedents: ${draped.failure} after ${safety} retries (${inputs.genre}/${inputs.segmentType})`,
      );
    }
  }
}

// ---- several melodic banks, hooks ----
//
// A rule may list several melodic banks (`"melodic": ["hooks", "schlager"]`).
// The candidate pool is their union, picked in two steps: first a bank, all
// listed banks equally likely, then an entry of that bank. Picking per bank
// keeps a small bank (about 100 hooks) from being drowned by a large one
// (stefan has 1201 entries): with a flat union, hooks would come up for under
// one section in ten.
//
// A legacy bank picked from the list behaves exactly as a single-bank rule
// naming it (the rule's rhythmic bank, tempo split and maxNote apply).
//
// The hooks bank (bank-index `hooks.bank`) holds complete melodies. When a
// list names it, the call first decides whether a hook would be used whole
// (probability `hooks.wholeShare`) or mixed, then builds the hooks pool for
// that use:
//   - section type: only hooks written for this section (`properties.type`
//     Verse / Pre-chorus / Chorus / Bridge for the sections verse /
//     preChorus / chorus / bridge);
//   - tempo: only hooks with `tempoMin <= song tempo <= tempoMax`;
// Hooks are placed under `hooks.maxNote[<section type>]`, not the rule's
// maxNote (which keeps applying to legacy picks).
//   - whole use only: the hook must fit the section's range by moving it by
//     whole octaves (see `wholeHookOctaveShift`); mixing needs at least two
//     hooks.
// An empty pool drops the hooks bank out of the bank choice; if the rule lists
// no other bank, that is an error naming the section, tempo and use (no silent
// switch to a bank the rule does not list).
//
// Used whole, the hook is both the rhythmic and the melodic precedent and is
// placed by the octave shift only: its rhythm, notes (intervals exact) and
// chords come out together. Mixed, the picked hook gives the pitch shape and
// chords and a second, different hook from the same pool gives the rhythm;
// the merged melody gets the usual buildContour placement (which may fold
// wide leaps). The rule's rhythmic bank is not used for hooks. Hooks go
// through the same length helper as legacy entries, so a lead-in bar
// (`start 1, end 9`) is cut off exactly as for the legacy start-1 entries.
//
// Rng draws per call of a list rule naming the hooks bank: whole-or-mixed,
// bank pick (always, even with one candidate bank); then, for a legacy bank,
// the legacy draws; for hooks: hook pick and (mixed) one partner pick per
// attempt. A list rule without the hooks bank draws only the bank pick.

const HOOK_TYPE_TO_SEGMENT: Readonly<Record<string, string>> = {
  Verse: 'verse',
  'Pre-chorus': 'preChorus',
  Chorus: 'chorus',
  Bridge: 'bridge',
};

const HookPropertiesSchema = z
  .object({
    kind: z.literal('hook'),
    type: z.enum(['Verse', 'Pre-chorus', 'Chorus', 'Bridge']),
    tempoMin: z.number().positive(),
    tempoMax: z.number().positive(),
  })
  .passthrough();

/** Hooks of the bank written for this section type and suiting the tempo. */
function hooksFor(bankId: string, segmentType: string, tempo: number): readonly Precedent[] {
  const bank = loadPrecedentBank(bankId);
  const out: Precedent[] = [];
  for (const entry of bank) {
    const parsed = HookPropertiesSchema.safeParse(entry.properties);
    if (!parsed.success) {
      throw new Error(
        `vocals/precedents: entry "${entry.id}" of the hooks bank "${bankId}" is not a hook (needs properties kind "hook", type, tempoMin, tempoMax): ${parsed.error.message}`,
      );
    }
    const p = parsed.data;
    if (HOOK_TYPE_TO_SEGMENT[p.type] === segmentType && p.tempoMin <= tempo && tempo <= p.tempoMax) out.push(entry);
  }
  return out;
}

/** The octave shift (a multiple of 12) that places a whole hook in the singing range [MIN_NOTE, maxNote], or
 *  `undefined` when no shift fits. Every note of the entry counts, the lead-in bar's too (a 16-bar section
 *  repeats the hook and sings the lead-in again). Among the shifts that fit, the highest is taken: moving a whole
 *  melody by octaves leaves every step the same, and on equal steps the usual placement (buildContour, priority
 *  "highNotes") prefers the higher peak, so this is the shift it would choose if it could only shift. */
export function wholeHookOctaveShift(hook: Precedent, maxNote: number): number | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const notes of Object.values(hook.melody)) {
    for (const n of notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
  }
  const shift = Math.floor((maxNote - hi) / 12) * 12;
  return lo + shift >= MIN_NOTE ? shift : undefined;
}

type MelodicChoice =
  | { readonly kind: 'legacy'; readonly bankId: string }
  | { readonly kind: 'hooks'; readonly pool: readonly Precedent[] };

function selectFromMelodicList(
  rule: GenreSegmentRule,
  bankIds: readonly string[],
  inputs: MergeInputs,
): MergedPrecedent {
  const hooks = loadBankIndex().hooks;
  const listsHooks = hooks !== undefined && bankIds.includes(hooks.bank);
  // Hooks are placed under the hooks setting's maxNote for this section type, not the rule's (legacy picks keep
  // the rule's maxNote through dispatchRule).
  const maxNote = listsHooks ? hooks.maxNote[inputs.segmentType] : undefined;
  if (listsHooks && maxNote === undefined) {
    throw new Error(
      `vocals/precedents: ${inputs.genre}/${inputs.segmentType} lists the hooks bank but bank-index hooks.maxNote has no entry for "${inputs.segmentType}"`,
    );
  }
  const whole = listsHooks ? inputs.rng.bool(hooks.wholeShare) : false;
  const choices: MelodicChoice[] = [];
  let hooksDroppedBecause: string | undefined;
  for (const bankId of bankIds) {
    if (!listsHooks || bankId !== hooks.bank) {
      choices.push({ kind: 'legacy', bankId });
      continue;
    }
    const suiting = hooksFor(bankId, inputs.segmentType, inputs.tempo);
    if (whole) {
      const pool = suiting.filter((h) => wholeHookOctaveShift(h, maxNote!) !== undefined);
      if (pool.length > 0) choices.push({ kind: 'hooks', pool });
      else {
        hooksDroppedBecause = `no hook in the hooks bank "${bankId}" is written for ${inputs.segmentType}, has tempoMin <= ${inputs.tempo} <= tempoMax and fits the range up to maxNote ${maxNote} by octave shifts, for use whole`;
      }
    } else if (suiting.length >= 2) {
      choices.push({ kind: 'hooks', pool: suiting });
    } else {
      hooksDroppedBecause = `the hooks bank "${bankId}" has ${suiting.length} hook(s) written for ${inputs.segmentType} with tempoMin <= ${inputs.tempo} <= tempoMax; mixing needs two`;
    }
  }
  if (choices.length === 0) {
    throw new Error(
      `vocals/precedents: no melody for ${inputs.genre}/${inputs.segmentType} at ${inputs.tempo} bpm: ${hooksDroppedBecause}, and the rule lists no other melodic bank`,
    );
  }
  const choice = inputs.rng.pick(choices);
  if (choice.kind === 'legacy') return mergeLegacy(dispatchRule(rule, choice.bankId, inputs.tempo), inputs);
  return whole ? mergeWholeHook(choice.pool, maxNote!, inputs) : mergeMixedHooks(choice.pool, maxNote!, inputs);
}

function hookWhere(inputs: MergeInputs): string {
  return `${inputs.genre}/${inputs.segmentType} at ${inputs.tempo} bpm`;
}

function mergeWholeHook(pool: readonly Precedent[], maxNote: number, inputs: MergeInputs): MergedPrecedent {
  const picked = rngPickHook(pool, inputs);
  const original = pool.find((h) => h.id === picked.id)!;
  const shift = wholeHookOctaveShift(original, maxNote)!;
  const draped = drapeAndPlace(picked, picked, maxNote, shift);
  if (!draped.ok) {
    throw new Error(`vocals/precedents: hook "${picked.id}" used whole: ${draped.failure} (${hookWhere(inputs)})`);
  }
  return draped.merged;
}

function rngPickHook(pool: readonly Precedent[], inputs: MergeInputs): Precedent {
  return pickHelperPrecedent(pool, { desiredPatternLength: inputs.desiredPatternLength }, inputs.rng);
}

function mergeMixedHooks(pool: readonly Precedent[], maxNote: number, inputs: MergeInputs): MergedPrecedent {
  const hook = rngPickHook(pool, inputs);
  const partners = pool.filter((e) => e.id !== hook.id);
  let safety = 0;
  while (true) {
    const rhythmHook = rngPickHook(partners, inputs);
    const draped = drapeAndPlace(rhythmHook, hook, maxNote, undefined);
    if (draped.ok) return draped.merged;
    if (safety++ > MAX_MERGE_RETRIES) {
      throw new Error(
        `vocals/precedents: hook "${hook.id}" mixed with other hooks: ${draped.failure} after ${safety} retries (${hookWhere(inputs)})`,
      );
    }
  }
}

// ---- drape + place (shared by every path) ----

type DrapeResult =
  | { readonly ok: true; readonly merged: MergedPrecedent }
  | { readonly ok: false; readonly failure: 'empty merged melody' | 'contour build failed' };

/** Drapes the melodic precedent's pitches over the rhythmic precedent's
 *  rhythm, lifts the melodic precedent's chords and places the melody: with
 *  `buildContour` (every legacy path, mixed hooks) or, given `octaveShift`
 *  (a whole hook), by moving every note by that many semitones. Deterministic;
 *  no rng. */
function drapeAndPlace(
  rhythmicPrecedent: Precedent,
  melodicPrecedent: Precedent,
  maxNote: number,
  octaveShift: number | undefined,
): DrapeResult {
  const merged: {
    melody: Record<string, { midi: number; duration: number }[]>;
    chords: Record<string, { chord: string }>;
  } = { melody: {}, chords: {} };

  // Drape melody of melodic precedent over rhythm of rhythmic precedent.
  const melodicBeats = Object.keys(melodicPrecedent.melody);
  const firstMelodicEntry = melodicPrecedent.melody[melodicBeats[0]!];
  let lastMidi = firstMelodicEntry?.[0]?.midi ?? 50;

  const rhythmicBeatStrings = Object.keys(rhythmicPrecedent.melody);
  for (let i = 0; i < rhythmicBeatStrings.length; i++) {
    const rhythmicBeatString = rhythmicBeatStrings[i]!;
    const notes = rhythmicPrecedent.melody[rhythmicBeatString]!;
    const rhythmicBeat = parseFloat(rhythmicBeatString);
    if (rhythmicBeat >= rhythmicPrecedent.properties.end * 4) break;
    if (rhythmicBeat < rhythmicPrecedent.properties.start * 4) continue;

    const close = getClosestNoteForBeat(
      rhythmicBeat,
      rhythmicBeat,
      rhythmicPrecedent,
      melodicPrecedent,
      lastMidi,
    );
    if (!close) continue;
    merged.melody[getBeatString(rhythmicBeat)] = [
      { midi: close.midi, duration: notes[0]!.duration },
    ];
    lastMidi = close.midi;
  }

  // Lift chords from melodic precedent (verbatim: only chord beats with
  // `beat >= 0` and `< end * 4`).
  for (const beatString of Object.keys(melodicPrecedent.chords)) {
    const beat = parseFloat(beatString);
    if (beat < 0) continue;
    if (beat >= melodicPrecedent.properties.end * 4) break;
    merged.chords[getBeatString(beat)] = { chord: melodicPrecedent.chords[beatString]!.chord };
  }

  // Build a single contour run over the entire draped melody.
  const beatStrings = Object.keys(merged.melody);
  if (beatStrings.length === 0) return { ok: false, failure: 'empty merged melody' };
  const midiSequence = beatStrings.map((bs) => merged.melody[bs]![0]!.midi);
  let optimalSequence: number[];
  if (octaveShift !== undefined) {
    optimalSequence = midiSequence.map((m) => m + octaveShift);
    const outside = optimalSequence.find((m) => m < MIN_NOTE || m > maxNote);
    if (outside !== undefined) {
      throw new Error(`vocals/precedents: octave shift ${octaveShift} puts midi ${outside} outside [${MIN_NOTE}..${maxNote}]`);
    }
  } else {
    try {
      optimalSequence = buildContour(midiSequence, { maxNote });
    } catch {
      return { ok: false, failure: 'contour build failed' };
    }
  }

  const melodyFirstNote = optimalSequence[0]!;
  const melodyLastNote = optimalSequence[optimalSequence.length - 1]!;
  let melodyMinNote = Infinity;
  let melodyMaxNote = -Infinity;
  for (let i = 0; i < beatStrings.length; i++) {
    const newMidi = optimalSequence[i]!;
    merged.melody[beatStrings[i]!] = [
      { midi: newMidi, duration: merged.melody[beatStrings[i]!]![0]!.duration },
    ];
    if (newMidi < melodyMinNote) melodyMinNote = newMidi;
    if (newMidi > melodyMaxNote) melodyMaxNote = newMidi;
  }

  return {
    ok: true,
    merged: {
      rhythmicPrecedentId: rhythmicPrecedent.id,
      rhythmicPrecedentName: rhythmicPrecedent.properties.name,
      melodicPrecedentId: melodicPrecedent.id,
      melodicPrecedentName: melodicPrecedent.properties.name,
      properties: {
        start: 0,
        end: melodicPrecedent.properties.end,
        maxNote,
        melodyFirstNote,
        melodyLastNote,
        melodyMinNote,
        melodyMaxNote,
      },
      melody: merged.melody,
      chords: merged.chords,
    },
  };
}

// ---- segment-grid emit ----

export interface MergedSegmentBeat {
  /** Bar index within the segment (0-based). */
  readonly barIndex: number;
  /** Bar-relative beat (0 ≤ beat < 4). */
  readonly beat: number;
  readonly midi: number;
  readonly duration: number;
}

/** Walks the merged precedent across `desiredPatternLength` bars in the
 *  same `_getPattern` shape the legacy generator used (line 1696+). */
export function expandMergedToSegment(
  merged: MergedPrecedent,
  desiredPatternLength: number,
): MergedSegmentBeat[] {
  const out: MergedSegmentBeat[] = [];
  const patternLength = merged.properties.end - merged.properties.start;
  if (patternLength <= 0) return out;
  const iterations = Math.floor(desiredPatternLength / patternLength);
  const beatStrings = Object.keys(merged.melody);
  for (let i = 0; i < iterations; i++) {
    for (const beatString of beatStrings) {
      const mergedBeat = parseFloat(beatString);
      const barIndex = Math.floor(mergedBeat / 4) + i * patternLength;
      const beat = mergedBeat % 4;
      const entry = merged.melody[beatString]![0]!;
      out.push({ barIndex, beat, midi: entry.midi, duration: entry.duration });
    }
  }
  // Legacy `_getPattern` (lines 1814-1845) tiles the remaining bars by
  // copying the tail of the last full iteration in chunks of 4/2/1 bars.
  // For 8-bar precedents the tail is always 0 when `desiredPatternLength`
  // is a multiple of 8, which covers every brightPop case today. We
  // replicate the legacy copy faithfully for the general case.
  const remaining = desiredPatternLength % patternLength;
  if (remaining > 0) {
    const firstBarToFill = desiredPatternLength - remaining;
    for (let i = firstBarToFill; i < desiredPatternLength; i += 2) {
      const remainingFromHere = desiredPatternLength - i;
      let copyFrom: number;
      let copyCount: number;
      if (remainingFromHere >= 4) {
        copyFrom = firstBarToFill - 4;
        copyCount = 4;
      } else if (remainingFromHere >= 2) {
        copyFrom = firstBarToFill - 2;
        copyCount = 2;
      } else {
        copyFrom = firstBarToFill - 1;
        copyCount = 1;
      }
      // Lift any beats from `out` whose barIndex falls into the source
      // window and re-emit them shifted by (i - copyFrom).
      const shift = i - copyFrom;
      for (const beat of out.slice()) {
        if (beat.barIndex >= copyFrom && beat.barIndex < copyFrom + copyCount) {
          out.push({ ...beat, barIndex: beat.barIndex + shift });
        }
      }
      i += copyCount - 2; // advance loop by 2/4/(or stay) to mirror legacy step
    }
  }
  return out;
}
