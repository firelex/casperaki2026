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
    melodic: z.string().min(1),
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
    genres: z.record(
      z.string(),
      z.record(z.string(), GenreSegmentRuleSchema),
    ),
  })
  .strict();

export type BankIndex = z.infer<typeof BankIndexSchema>;

// ---- cached loaders ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/vocals/MelodyClass.js:1098-1665 (_getMergedRhythmicAndMelodicPrecedent)',
  extractedAt: '2026-06-07',
};

let cachedIndex: BankIndex | undefined;
const cachedBanks = new Map<string, readonly Precedent[]>();

export function loadBankIndex(): BankIndex {
  if (cachedIndex) return cachedIndex;
  const path = resolve(DATA_DIR, BANK_INDEX_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(BANK_INDEX_META, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = BankIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(BANK_INDEX_META, `invalid bank index: ${parsed.error.message}`);
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
    raw = JSON.parse(readFileSync(resolve(DATA_DIR, entry.file), 'utf8'));
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

/** Returns `undefined` when the dispatcher has no precedent for the given
 *  segment (e.g. "intro" / "outro" / "break"); the caller skips those. */
export function dispatchPrecedent(inputs: DispatchInputs): DispatchResult | undefined {
  const index = loadBankIndex();
  const genreRules = index.genres[inputs.genre];
  if (!genreRules) {
    throw new DataAssetError(BANK_INDEX_META, `no dispatcher entry for genre "${inputs.genre}"`);
  }
  const rule = genreRules[inputs.segmentType];
  if (!rule) return undefined;

  const melodicBank = loadPrecedentBank(rule.melodic);
  let rhythmicBank: readonly Precedent[] | undefined;
  if (rule.rhythmic) {
    rhythmicBank = loadPrecedentBank(rule.rhythmic);
    if (rule.rhythmicTempoSplit !== undefined) {
      rhythmicBank = sliceByTempo(rhythmicBank, inputs.tempo, rule.rhythmicTempoSplit);
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
 *  `undefined` for segment types the dispatcher has no entry for. */
export function selectMergedPrecedent(inputs: MergeInputs): MergedPrecedent | undefined {
  const dispatch = dispatchPrecedent({
    genre: inputs.genre,
    segmentType: inputs.segmentType,
    tempo: inputs.tempo,
  });
  if (!dispatch) return undefined;
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
    if (beatStrings.length === 0) {
      // Retry — bank pick may have produced an empty merge under
      // segment-type / chord-grid drift.
      if (safety++ > MAX_MERGE_RETRIES) {
        throw new Error(
          `vocals/precedents: empty merged melody after ${safety} retries (${inputs.genre}/${inputs.segmentType})`,
        );
      }
      continue;
    }
    const midiSequence = beatStrings.map((bs) => merged.melody[bs]![0]!.midi);
    let optimalSequence: number[] | undefined;
    try {
      optimalSequence = buildContour(midiSequence, { maxNote });
    } catch {
      if (safety++ > MAX_MERGE_RETRIES) {
        throw new Error(
          `vocals/precedents: contour build failed after ${safety} retries (${inputs.genre}/${inputs.segmentType})`,
        );
      }
      continue;
    }

    let melodyFirstNote = optimalSequence[0]!;
    let melodyLastNote = optimalSequence[optimalSequence.length - 1]!;
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
    };
  }
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
