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
import { melodyStats } from './hook-text.js';
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

const PrecedentSourceSchema = z
  .object({
    kind: z.enum(['song', 'casperaki']),
    title: z.string().min(1).optional(),
    artist: z.string().min(1).optional(),
  })
  .strict();

export type PrecedentSource = z.infer<typeof PrecedentSourceSchema>;

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
    // Required on every entry (written into the bank files by scripts/add-precedent-flags.mjs; no defaults).
    useOriginal: z.boolean(), // may be sung whole, exactly as written (moved by octaves only)
    useRemix: z.boolean(), // may take part in the mixing merge
    source: PrecedentSourceSchema,
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

// ---- edits overlay ----
//
// The brain keeps the admin's edits of bank entries outside the repo and hands them over with `setPrecedentEdits`
// (at startup and after each save). `loadPrecedentBank`, and so every selection, sees the edited entries: `melody`
// and `chords` replace the bank's wholesale (and the melody's statistics busyness / lowestNote / highestNote /
// medianNote are recomputed from it, as hook-text does); `useOriginal`, `useRemix` and `source` replace those
// properties (`source` as a whole object); `editedAt` / `editedBy` are recorded in the properties. Everything else
// stays as in the bank file. Edits are in the bank format and register, exactly as the bank files.

const PrecedentEditSchema = z
  .object({
    melody: z.record(BeatStringSchema, z.array(MelodyNoteSchema).min(1)).optional(),
    chords: z.record(BeatStringSchema, ChordEntrySchema).optional(),
    useOriginal: z.boolean().optional(),
    useRemix: z.boolean().optional(),
    source: PrecedentSourceSchema.optional(),
    editedAt: z.string().min(1),
    editedBy: z.string().min(1).optional(),
  })
  .strict();

export type PrecedentEdit = z.infer<typeof PrecedentEditSchema>;

let precedentEdits: Readonly<Record<string, PrecedentEdit>> = {};

function applyEdit(entry: Precedent, edit: PrecedentEdit): Precedent {
  const melody = edit.melody ?? entry.melody;
  const properties: Record<string, unknown> = { ...entry.properties };
  if (edit.melody) Object.assign(properties, melodyStats(edit.melody));
  if (edit.useOriginal !== undefined) properties['useOriginal'] = edit.useOriginal;
  if (edit.useRemix !== undefined) properties['useRemix'] = edit.useRemix;
  if (edit.source !== undefined) properties['source'] = edit.source;
  properties['editedAt'] = edit.editedAt;
  if (edit.editedBy !== undefined) properties['editedBy'] = edit.editedBy;
  return { ...entry, properties: properties as Precedent['properties'], melody, chords: edit.chords ?? entry.chords };
}

/** Replaces the edits overlay (keys "<bank>/<id>"). Throws, leaving the previous overlay in place, when an edit is
 *  invalid, names an unknown bank or entry, or makes an entry invalid. */
export function setPrecedentEdits(edits: Readonly<Record<string, PrecedentEdit>>): void {
  const parsed: Record<string, PrecedentEdit> = {};
  for (const [key, edit] of Object.entries(edits)) {
    const r = PrecedentEditSchema.safeParse(edit);
    if (!r.success) throw new Error(`vocals/precedents: invalid edit "${key}": ${r.error.message}`);
    parsed[key] = r.data;
  }
  const previous = precedentEdits;
  precedentEdits = parsed;
  cachedBanks.clear();
  try {
    const index = loadBankIndex();
    for (const key of Object.keys(parsed)) {
      const slash = key.indexOf('/');
      const bankId = slash === -1 ? '' : key.slice(0, slash);
      const id = key.slice(slash + 1);
      if (!index.banks[bankId]) throw new Error(`vocals/precedents: edit "${key}" names an unknown bank "${bankId}"`);
      if (!loadRawBank(bankId).some((e) => String(e.id) === id)) {
        throw new Error(`vocals/precedents: edit "${key}": bank "${bankId}" has no entry "${id}"`);
      }
    }
    for (const bankId of new Set(Object.keys(parsed).map((k) => k.slice(0, k.indexOf('/'))))) loadPrecedentBank(bankId);
  } catch (err) {
    precedentEdits = previous;
    cachedBanks.clear();
    throw err;
  }
}

// ---- bank index schema ----

const GenreSegmentRuleSchema = z
  .object({
    // A single bank id (every legacy rule) or a list of bank ids whose union is the melodic pool (see
    // "selection: flags, several banks, hooks" below).
    melodic: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    rhythmic: z.string().min(1).optional(),
    maxNote: z.number().int().positive().optional(),
  })
  .strict();

const Weight = z.number().min(0);
const RecipeWeightsSchema = z
  .object({
    hookWhole: Weight,
    hookOnHook: Weight,
    hookOnStyle: Weight,
    curatedOnStyle: Weight,
    curatedOnHook: Weight,
    curatedBanks: z.record(z.string(), z.number().positive()),
  })
  .strict();

const BankIndexSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string().optional(),
    $legacySource: z.record(z.string()).optional(),
    $dispatcherNotes: z.record(z.string()).optional(),
    banks: z.record(z.string(), z.object({ file: z.string().min(1) }).strict()),
    // For an entry with both useOriginal and useRemix: the probability it is used whole when picked.
    wholeShare: z.number().min(0).max(1),
    // How busy a melody may be at the song's tempo, and from which tempo it may be sung in half time (see
    // "tempo fit" below).
    tempoFit: z
      .object({
        // Notes per second a melody may have at the song's tempo (notes per bar x bpm / 240).
        maxNotesPerSecond: z.number().positive(),
        // From this tempo on, every entry may also be used in half time (twice as long: positions and lengths x2).
        halfTimeFromBpm: z.number().positive(),
      })
      .strict(),
    // The hooks bank (our own complete melodies, docs/superpowers/specs/2026-11-24-hook-library-design.md).
    hooks: z
      .object({
        bank: z.string().min(1),
        // Highest note (legacy register) for placing hooks, per section type. Used for hooks only, whole and
        // mixed, in place of the rule's maxNote (which keeps applying to legacy entries).
        maxNote: z.record(z.string(), z.number().int().positive()),
      })
      .strict()
      .optional(),
    // Per section type: how likely each way of making the melody is (relative weights), and how the curated
    // (non-hook) banks are weighted when one is drawn. See "selection: recipes" below. Absent: the bank pick.
    recipes: z.record(z.string(), RecipeWeightsSchema).optional(),
    genres: z.record(
      z.string(),
      z.record(z.string(), GenreSegmentRuleSchema),
    ),
  })
  .strict();

export type BankIndex = z.infer<typeof BankIndexSchema>;
export type GenreSegmentRule = z.infer<typeof GenreSegmentRuleSchema>;

/** Rules the schema cannot express: the hooks bank exists and is never a rhythmic bank, and melodic lists name
 *  known banks once. */
function checkBankIndex(index: BankIndex): string[] {
  const problems: string[] = [];
  const hooksBank = index.hooks?.bank;
  if (hooksBank !== undefined && !index.banks[hooksBank]) {
    problems.push(`hooks.bank "${hooksBank}" is not listed under banks`);
  }
  for (const [genre, rules] of Object.entries(index.genres)) {
    for (const [segmentType, rule] of Object.entries(rules)) {
      const where = `genres.${genre}.${segmentType}`;
      if (typeof rule.melodic !== 'string') {
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
      const recipe = index.recipes?.[segmentType];
      if (recipe && typeof rule.melodic !== 'string') {
        for (const id of rule.melodic) {
          if (id !== hooksBank && recipe.curatedBanks[id] === undefined) {
            problems.push(`${where}: melodic bank "${id}" has no weight in recipes.${segmentType}.curatedBanks`);
          }
        }
      }
    }
  }
  for (const [segmentType, recipe] of Object.entries(index.recipes ?? {})) {
    if (hooksBank === undefined) problems.push(`recipes.${segmentType}: recipes need the hooks bank (bank-index "hooks")`);
    for (const id of Object.keys(recipe.curatedBanks)) {
      if (!index.banks[id]) problems.push(`recipes.${segmentType}.curatedBanks: "${id}" is not listed under banks`);
      if (id === hooksBank) problems.push(`recipes.${segmentType}.curatedBanks: the hooks bank is not a curated bank`);
    }
    if (RECIPES.every((r) => recipe[r] === 0)) problems.push(`recipes.${segmentType}: every recipe weight is 0`);
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
const cachedBanks = new Map<string, readonly Precedent[]>(); // with the edits overlay
const cachedRawBanks = new Map<string, readonly Precedent[]>(); // as in the files

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
  cachedRawBanks.clear();
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

/** A bank as in its file (validated, no edits). */
function loadRawBank(bankId: string): readonly Precedent[] {
  const cached = cachedRawBanks.get(bankId);
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
  cachedRawBanks.set(bankId, frozen);
  return frozen;
}

/** A bank with the edits overlay applied (see `setPrecedentEdits`). */
export function loadPrecedentBank(bankId: string): readonly Precedent[] {
  const cached = cachedBanks.get(bankId);
  if (cached) return cached;
  const raw = loadRawBank(bankId);
  const prefix = `${bankId}/`;
  const editKeys = Object.keys(precedentEdits).filter((k) => k.startsWith(prefix));
  let bank = raw;
  if (editKeys.length > 0) {
    bank = raw.map((e) => {
      const edit = precedentEdits[`${prefix}${String(e.id)}`];
      if (!edit) return e;
      const r = PrecedentSchema.safeParse(applyEdit(e, edit));
      if (!r.success) throw new Error(`vocals/precedents: the edit of "${prefix}${String(e.id)}" makes an invalid entry: ${r.error.message}`);
      return r.data;
    });
    Object.freeze(bank);
  }
  cachedBanks.set(bankId, bank);
  return bank;
}

// ---- tempo fit: notes per second, half time ----
//
// A melody that suits a slow song is too busy for a fast one: what the ear hears is notes per second, so every
// selection draws from the entries whose notes per second at the song's tempo (notes per bar x bpm / 240) are at
// most `tempoFit.maxNotesPerSecond`. From `tempoFit.halfTimeFromBpm` on, each entry may also be sung in half time:
// a copy twice as long (every position and length x2, each chord held for two beats, its tempo or tempo range x2,
// id "<id>@half"), which halves its notes per second, so a fast song sings long notes (the usual half-time vocal of
// dance music). Every path (hooks whole or mixed, style rhythms, curated melodies, the legacy merge) draws from this
// pool, so the tempo checks that follow (a hook's tempoMin..tempoMax, a whole legacy entry's +-10 bpm) see the
// half-time copies at their doubled tempo. Replaces the legacy tempo split of the rhythmic banks (the five
// sparsest or busiest entries dropped either side of 133 bpm).

const HALF_TIME_SUFFIX = '@half';

/** An entry's id without the half-time suffix: the same melody whether used as written or in half time. */
function baseId(entry: Precedent): string {
  const id = String(entry.id);
  return id.endsWith(HALF_TIME_SUFFIX) ? id.slice(0, -HALF_TIME_SUFFIX.length) : id;
}

/** How many different melodies a pool holds (an entry and its half-time copy are one). */
function distinctMelodies(pool: readonly Precedent[]): number {
  return new Set(pool.map(baseId)).size;
}

/** Notes per bar of an entry, counted from its melody (beats from start*4 to end*4). */
function notesPerBar(entry: Precedent): number {
  const from = entry.properties.start * 4;
  const to = entry.properties.end * 4;
  const notes = Object.keys(entry.melody).filter((b) => {
    const beat = parseFloat(b);
    return beat >= from && beat < to;
  }).length;
  return notes / (entry.properties.end - entry.properties.start);
}

function notesPerSecond(entry: Precedent, tempo: number): number {
  return (notesPerBar(entry) * tempo) / 240;
}

function doubledTempo(tempo: string | number | undefined): string | number | undefined {
  if (tempo === undefined) return undefined;
  if (typeof tempo === 'number') return tempo * 2;
  const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/u.exec(tempo);
  if (range) return `${Number(range[1]) * 2}-${Number(range[2]) * 2}`;
  const n = Number(tempo);
  if (!Number.isFinite(n)) throw new Error(`vocals/precedents: cannot read the tempo "${tempo}" to double it`);
  return String(n * 2);
}

/** The half-time copy of an entry: twice as long, every position and length x2, each chord held for two beats. */
export function halfTimeCopy(entry: Precedent): Precedent {
  const melody: Record<string, PrecedentMelodyNote[]> = {};
  for (const [beat, notes] of Object.entries(entry.melody)) {
    melody[getBeatString(parseFloat(beat) * 2)] = notes.map((n) => ({ ...n, duration: n.duration * 2 }));
  }
  const chords: Record<string, { chord: string }> = {};
  for (const [beat, c] of Object.entries(entry.chords)) {
    const b = parseFloat(beat) * 2;
    chords[getBeatString(b)] = { ...c };
    chords[getBeatString(b + 1)] = { ...c };
  }
  const p = entry.properties as Precedent['properties'] & { tempoMin?: number; tempoMax?: number };
  const properties: Record<string, unknown> = {
    ...p,
    start: p.start * 2,
    end: p.end * 2,
    tempo: doubledTempo(p.tempo),
    ...(p.busyness !== undefined ? { busyness: p.busyness / 2 } : {}),
    ...(p.tempoMin !== undefined ? { tempoMin: p.tempoMin * 2 } : {}),
    ...(p.tempoMax !== undefined ? { tempoMax: p.tempoMax * 2 } : {}),
    halfTime: true,
  };
  return { ...entry, id: `${String(entry.id)}${HALF_TIME_SUFFIX}`, properties: properties as Precedent['properties'], melody, chords };
}

/** Tempo pools by "<bank>@<bpm>", each with the bank it was made from (a new bank, after edits or test data,
 *  makes the pool again). */
const cachedTempoBanks = new Map<string, { readonly from: readonly Precedent[]; readonly pool: readonly Precedent[] }>();

/** The entries of a bank a song at `tempo` may draw from: those not busier than tempoFit allows, and from
 *  halfTimeFromBpm on also the half-time copies that fit (bank order, then the copies in bank order). */
export function tempoBank(bankId: string, tempo: number): readonly Precedent[] {
  const bank = loadPrecedentBank(bankId);
  const key = `${bankId}@${tempo}`;
  const cached = cachedTempoBanks.get(key);
  if (cached?.from === bank) return cached.pool;
  const fit = loadBankIndex().tempoFit;
  const ok = (e: Precedent) => notesPerSecond(e, tempo) <= fit.maxNotesPerSecond + 1e-9;
  const pool = bank.filter(ok);
  if (tempo >= fit.halfTimeFromBpm) pool.push(...bank.map(halfTimeCopy).filter(ok));
  const frozen = Object.freeze(pool) as readonly Precedent[];
  cachedTempoBanks.set(key, { from: bank, pool: frozen });
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

function lookupRule(inputs: DispatchInputs): GenreSegmentRule | undefined {
  const index = loadBankIndex();
  const genreRules = index.genres[inputs.genre];
  if (!genreRules) {
    throw new DataAssetError(BANK_INDEX_META, `no dispatcher entry for genre "${inputs.genre}"`);
  }
  return genreRules[inputs.segmentType];
}

const remixable = (bank: readonly Precedent[]) => bank.filter((e) => e.properties.useRemix);

/** The rule's rhythmic bank (its useRemix entries that fit the tempo), or undefined without one or when none fits. */
function styleRhythms(rule: GenreSegmentRule, tempo: number): readonly Precedent[] | undefined {
  if (!rule.rhythmic) return undefined;
  const bank = remixable(tempoBank(rule.rhythmic, tempo));
  return bank.length > 0 ? bank : undefined;
}

/** The legacy dispatch of one rule with one melodic bank, over the entries flagged `useRemix` that fit the tempo
 *  (see "tempo fit"; in the bank's order). */
function dispatchRule(rule: GenreSegmentRule, melodicBankId: string, tempo: number): DispatchResult {
  const melodicBank = remixable(tempoBank(melodicBankId, tempo));
  if (melodicBank.length === 0) throw new Error(`vocals/precedents: bank "${melodicBankId}" has no entry flagged useRemix that fits ${tempo} bpm`);
  const rhythmicBank = styleRhythms(rule, tempo);
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
  /** How the melody was made, when the bank index has recipes for the section (see "selection: recipes"). */
  readonly recipe?: Recipe;
  /** The entries it was made from, as shaped for the section (a whole hook: the hook both times), so a melody can be
   *  laid on another rhythm (drapeOnRhythm) or a rhythm kept under another melody. */
  readonly rhythmic: Precedent;
  readonly melodic: Precedent;
}

const MAX_MERGE_RETRIES = 6; // legacy: `if (safety++ > 5) throw`

/** The melody of one section: a precedent used whole, or the merge of two
 *  (faithful port of `_getMergedRhythmicAndMelodicPrecedent`). Returns
 *  `undefined` for segment types the dispatcher has no entry for. See
 *  "selection: flags, several banks, hooks" below. */
export function selectMergedPrecedent(inputs: MergeInputs): MergedPrecedent | undefined {
  const rule = lookupRule(inputs);
  if (!rule) return undefined;
  const recipe = loadBankIndex().recipes?.[inputs.segmentType];
  if (recipe && typeof rule.melodic !== 'string') return selectByRecipe(rule, rule.melodic, recipe, inputs);
  const bankIds = typeof rule.melodic === 'string' ? [rule.melodic] : rule.melodic;
  const plans = bankIds.map((bankId) => planBank(rule, bankId, inputs));
  const usable = plans.filter((p) => p.whole.length > 0 || p.remix !== undefined);
  if (usable.length === 0) {
    throw new Error(
      `vocals/precedents: no melody for ${inputs.genre}/${inputs.segmentType} at ${inputs.tempo} bpm: ${plans.map((p) => p.why).join('; ')}`,
    );
  }
  // A single-bank rule draws no bank pick (the legacy draws); a list always draws one, even with one usable bank.
  const plan = typeof rule.melodic === 'string' ? usable[0]! : inputs.rng.pick(usable);
  return selectInBank(plan, inputs);
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

// ---- selection: flags, several banks, hooks ----
//
// Every bank entry carries two flags: `useOriginal` (it may be sung whole,
// exactly as written, moved by whole octaves only) and `useRemix` (it may
// take part in the mixing merge). Hooks have both; the legacy banks are
// remix-only (scripts/add-precedent-flags.mjs; the admin can change the flags
// through the edits overlay).
//
// A rule names one melodic bank or a list. With a list, a bank is picked
// first, every usable listed bank equally likely, then an entry of it:
// picking per bank keeps a small bank (about 100 hooks) from being drowned by
// a large one. A single-bank rule draws no bank pick.
//
// Within the bank:
//   - Whole candidates: entries flagged useOriginal, written for this section
//     type (properties.type Verse / Pre-chorus (or Prechorus) / Chorus /
//     Bridge for verse / preChorus / chorus / bridge), suiting the tempo
//     (hooks: tempoMin <= tempo <= tempoMax; legacy entries have one tempo,
//     accepted within ±10 bpm of the song tempo) and fitting the section's
//     range [43..maxNote] by an octave shift (`wholeOctaveShift`). maxNote is
//     `hooks.maxNote[<section type>]` for hooks, the rule's maxNote (default
//     59) for legacy entries.
//   - Remix candidates: for a legacy bank, its entries flagged useRemix,
//     merged exactly as the legacy port (rhythm from the rule's rhythmic bank
//     (its useRemix entries); no type or tempo filter). For the hooks bank,
//     hooks flagged useRemix, of the section type and tempo; mixing takes the
//     pitch shape and chords of one and the rhythm of another, so it needs two.
//   - No whole candidate: the remix merge runs directly, with the legacy rng
//     draws. So a single-bank rule over remix-only entries (every legacy rule
//     today) draws and sings exactly as before the flags existed.
//   - Otherwise one entry is drawn from the union of both candidate sets. A
//     whole-only candidate is sung whole; a remix-only candidate means the
//     remix merge runs (which picks its own pair, as always); a candidate in
//     both is sung whole with probability `wholeShare` (bank index), else the
//     remix merge runs.
// A bank with no candidate of either kind is not usable; when no listed bank
// is usable, the error names the section, tempo and each bank's reason.
//
// Sung whole, the entry is both the rhythmic and the melodic precedent and
// is placed by the octave shift only: rhythm, notes (intervals exact) and
// chords come out as written. Lead-in bars (start 1, end 9) are cut off by the
// same length helper as in the merge (dropped in an 8-bar section).

const TYPE_TO_SEGMENT: Readonly<Record<string, string>> = {
  Verse: 'verse',
  'Pre-chorus': 'preChorus',
  Prechorus: 'preChorus',
  Chorus: 'chorus',
  Bridge: 'bridge',
};

/** Legacy entries carry one tempo; used whole they suit songs within this many bpm of it. */
const LEGACY_WHOLE_TEMPO_WINDOW = 10;

const HookPropertiesSchema = z
  .object({
    kind: z.literal('hook'),
    type: z.enum(['Verse', 'Pre-chorus', 'Chorus', 'Bridge']),
    tempoMin: z.number().positive(),
    tempoMax: z.number().positive(),
  })
  .passthrough();

/** The octave shift (a multiple of 12) that places a whole entry in the singing range [MIN_NOTE, maxNote], or
 *  `undefined` when no shift fits. Every note of the entry counts, a lead-in bar's too (a 16-bar section repeats
 *  the entry and sings the lead-in again). Among the shifts that fit, the highest is taken: moving a whole
 *  melody by octaves leaves every step the same, and on equal steps the usual placement (buildContour, priority
 *  "highNotes") prefers the higher peak, so this is the shift it would choose if it could only shift. */
export function wholeOctaveShift(entry: Precedent, maxNote: number): number | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const notes of Object.values(entry.melody)) {
    for (const n of notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
  }
  const shift = Math.floor((maxNote - hi) / 12) * 12;
  return lo + shift >= MIN_NOTE ? shift : undefined;
}

interface WholeCandidate {
  readonly entry: Precedent;
  readonly shift: number;
}

interface BankPlan {
  readonly bankId: string;
  readonly rule: GenreSegmentRule;
  /** Entries that may be sung whole here, with their octave shift. */
  readonly whole: readonly WholeCandidate[];
  /** How to remix, when the bank can: the legacy merge, or mixing among hooks. */
  readonly remix:
    | { readonly kind: 'legacy'; readonly entries: readonly Precedent[] }
    | { readonly kind: 'hooks'; readonly entries: readonly Precedent[]; readonly maxNote: number }
    | undefined;
  readonly wholeMaxNote: number;
  /** Why the bank is not usable, in words (for the error when no bank is). */
  readonly why: string;
}

function planBank(rule: GenreSegmentRule, bankId: string, inputs: Omit<MergeInputs, 'rng'>): BankPlan {
  const index = loadBankIndex();
  const bank = tempoBank(bankId, inputs.tempo);
  const isHooks = index.hooks !== undefined && bankId === index.hooks.bank;
  const ofSection = (e: Precedent) => e.properties.type !== undefined && TYPE_TO_SEGMENT[e.properties.type] === inputs.segmentType;

  if (isHooks) {
    const maxNote = index.hooks!.maxNote[inputs.segmentType];
    if (maxNote === undefined) {
      throw new Error(
        `vocals/precedents: ${inputs.genre}/${inputs.segmentType} uses the hooks bank but bank-index hooks.maxNote has no entry for "${inputs.segmentType}"`,
      );
    }
    for (const e of bank) {
      const r = HookPropertiesSchema.safeParse(e.properties);
      if (!r.success) {
        throw new Error(
          `vocals/precedents: entry "${e.id}" of the hooks bank "${bankId}" is not a hook (needs properties kind "hook", type, tempoMin, tempoMax): ${r.error.message}`,
        );
      }
    }
    const suiting = bank.filter((e) => {
      const p = e.properties as unknown as { tempoMin: number; tempoMax: number };
      return ofSection(e) && p.tempoMin <= inputs.tempo && inputs.tempo <= p.tempoMax;
    });
    const whole = wholeCandidates(suiting, maxNote);
    const mixable = suiting.filter((e) => e.properties.useRemix);
    return {
      bankId,
      rule,
      whole,
      remix: distinctMelodies(mixable) >= 2 ? { kind: 'hooks', entries: mixable, maxNote } : undefined,
      wholeMaxNote: maxNote,
      why: `hooks bank "${bankId}": ${suiting.length} hook(s) written for ${inputs.segmentType} with tempoMin <= ${inputs.tempo} <= tempoMax, ${whole.length} of them may be sung whole and fit the range up to maxNote ${maxNote}, ${mixable.length} may be remixed (mixing needs two)`,
    };
  }

  const maxNote = rule.maxNote ?? DEFAULT_MAX_NOTE;
  const suiting = bank.filter((e) => {
    if (!e.properties.useOriginal || !ofSection(e)) return false;
    if (e.properties.tempo === undefined) {
      throw new Error(`vocals/precedents: entry "${bankId}/${e.id}" may be sung whole but has no tempo`);
    }
    return Math.abs(Number(e.properties.tempo) - inputs.tempo) <= LEGACY_WHOLE_TEMPO_WINDOW;
  });
  const whole = wholeCandidates(suiting, maxNote);
  const remix = bank.some((e) => e.properties.useRemix) ? { kind: 'legacy' as const, entries: remixable(bank) } : undefined;
  return {
    bankId,
    rule,
    whole,
    remix,
    wholeMaxNote: maxNote,
    why: `bank "${bankId}": ${whole.length} entries may be sung whole here (useOriginal, written for ${inputs.segmentType}, tempo within ${LEGACY_WHOLE_TEMPO_WINDOW} bpm, fits up to maxNote ${maxNote}) and ${remix ? 'some' : 'none'} may be remixed`,
  };
}

function wholeCandidates(entries: readonly Precedent[], maxNote: number): WholeCandidate[] {
  const out: WholeCandidate[] = [];
  for (const entry of entries) {
    if (!entry.properties.useOriginal) continue;
    const shift = wholeOctaveShift(entry, maxNote);
    if (shift !== undefined) out.push({ entry, shift });
  }
  return out;
}

function selectInBank(plan: BankPlan, inputs: MergeInputs): MergedPrecedent {
  if (plan.whole.length === 0) return remixInBank(plan, inputs);
  const remixIds = new Set((plan.remix?.entries ?? []).map((e) => e.id));
  const wholeIds = new Set(plan.whole.map((w) => w.entry.id));
  const union = [...plan.whole.map((w) => w.entry), ...(plan.remix?.entries ?? []).filter((e) => !wholeIds.has(e.id))];
  const picked = inputs.rng.pick(union);
  const asWhole = plan.whole.find((w) => w.entry.id === picked.id);
  const sungWhole = asWhole !== undefined && (!remixIds.has(picked.id) || inputs.rng.bool(loadBankIndex().wholeShare));
  return sungWhole ? mergeWhole(asWhole, plan, inputs) : remixInBank(plan, inputs);
}

function remixInBank(plan: BankPlan, inputs: MergeInputs): MergedPrecedent {
  const remix = plan.remix;
  if (!remix) throw new Error(`vocals/precedents: ${plan.why}`); // unreachable: planBank made the bank usable
  if (remix.kind === 'legacy') return mergeLegacy(dispatchRule(plan.rule, plan.bankId, inputs.tempo), inputs);
  return mergeMixedHooks(remix.entries, remix.maxNote, inputs);
}

function where(inputs: Omit<MergeInputs, 'rng'>): string {
  return `${inputs.genre}/${inputs.segmentType} at ${inputs.tempo} bpm`;
}

function mergeWhole(candidate: WholeCandidate, plan: BankPlan, inputs: MergeInputs): MergedPrecedent {
  const shaped = pickHelperPrecedent([candidate.entry], { desiredPatternLength: inputs.desiredPatternLength }, inputs.rng);
  const draped = drapeAndPlace(shaped, shaped, plan.wholeMaxNote, candidate.shift);
  if (!draped.ok) {
    throw new Error(`vocals/precedents: "${plan.bankId}/${candidate.entry.id}" sung whole: ${draped.failure} (${where(inputs)})`);
  }
  return draped.merged;
}

function mergeMixedHooks(pool: readonly Precedent[], maxNote: number, inputs: MergeInputs): MergedPrecedent {
  const params = { desiredPatternLength: inputs.desiredPatternLength };
  let safety = 0;
  while (true) {
    // Like drapePair, a failed placement draws both again: some hook shapes fit the section's range on no partner
    // rhythm (a narrow verse range), and retrying only the partner would fail every time.
    const hook = pickHelperPrecedent(pool, params, inputs.rng);
    const partners = pool.filter((e) => baseId(e) !== baseId(hook)); // not the hook itself, nor its half-time copy
    const rhythmHook = pickHelperPrecedent(partners, params, inputs.rng);
    const draped = drapeAndPlace(rhythmHook, hook, maxNote, undefined);
    if (draped.ok) return draped.merged;
    if (safety++ > MAX_MERGE_RETRIES) {
      throw new Error(
        `vocals/precedents: hook "${hook.id}" mixed with other hooks: ${draped.failure} after ${safety} retries (${where(inputs)})`,
      );
    }
  }
}

// ---- selection: recipes ----
//
// With `recipes` in the bank index (per section type), a rule listing several melodic banks draws one of five
// recipes, by the section's relative weights among the recipes that can be made here:
//   - hookWhole:      a hook sung whole (its rhythm, notes and chords as written, moved by octaves).
//   - hookOnHook:     a hook's pitch shape and chords on another hook's rhythm (both of the section type and tempo).
//   - hookOnStyle:    a hook's pitch shape and chords on a rhythm of the rule's rhythmic bank (the style's rhythm).
//   - curatedOnStyle: a curated bank, drawn by `curatedBanks` weight, sung as before recipes (the legacy merge on
//                     the style's rhythm, or whole if the admin flagged an entry Original).
//   - curatedOnHook:  a curated entry's pitch shape and chords (curated bank drawn by weight) on a hook's rhythm.
// Hooks are the listed hooks bank's entries flagged useRemix, of the section type and suiting the tempo; whole
// hooks also fit the range (hooks.maxNote). A hook melody is placed up to hooks.maxNote, a curated one up to the
// rule's maxNote. A recipe that cannot be made here (no hook for this tempo, no rhythmic bank, ...) is left out
// and the others keep their relative weights; when none can be made, generation stops with an error.

export const RECIPES = ['hookWhole', 'hookOnHook', 'hookOnStyle', 'curatedOnStyle', 'curatedOnHook'] as const;
export type Recipe = (typeof RECIPES)[number];
type RecipeWeights = z.infer<typeof RecipeWeightsSchema>;

function selectByRecipe(rule: GenreSegmentRule, bankIds: readonly string[], weights: RecipeWeights, inputs: MergeInputs): MergedPrecedent {
  const index = loadBankIndex();
  const hooksId = index.hooks!.bank; // checkBankIndex: recipes need the hooks bank
  const hookPlan = bankIds.includes(hooksId) ? planBank(rule, hooksId, inputs) : undefined;
  const hooks = hookPlan ? remixableHooks(hookPlan, inputs) : [];
  const hookMaxNote = index.hooks!.maxNote[inputs.segmentType]!;
  const curatedPlans = bankIds.filter((id) => id !== hooksId).map((id) => planBank(rule, id, inputs)).filter((p) => p.whole.length > 0 || p.remix !== undefined);
  const curatedRemix = curatedPlans.filter((p) => p.remix?.kind === 'legacy');
  const style = styleRhythms(rule, inputs.tempo);

  const can: Record<Recipe, boolean> = {
    hookWhole: (hookPlan?.whole.length ?? 0) > 0,
    hookOnHook: distinctMelodies(hooks) >= 2,
    hookOnStyle: hooks.length >= 1 && style !== undefined,
    curatedOnStyle: curatedPlans.length > 0,
    curatedOnHook: hooks.length >= 1 && curatedRemix.length > 0,
  };
  const options = RECIPES.filter((r) => can[r] && weights[r] > 0);
  if (options.length === 0) {
    throw new Error(
      `vocals/precedents: no recipe can make a melody for ${where(inputs)}: ${RECIPES.map((r) => `${r} ${can[r] ? `weight ${weights[r]}` : 'cannot be made'}`).join(', ')}; ${[hookPlan, ...curatedPlans].filter(Boolean).map((p) => p!.why).join('; ')}`,
    );
  }
  const recipe = inputs.rng.pickWeighted(options, options.map((r) => weights[r]));
  const pickCurated = (plans: readonly BankPlan[]) => inputs.rng.pickWeighted(plans, plans.map((p) => weights.curatedBanks[p.bankId]!));
  const made = (merged: MergedPrecedent): MergedPrecedent => ({ ...merged, recipe });

  switch (recipe) {
    case 'hookWhole':
      return made(mergeWhole(inputs.rng.pick(hookPlan!.whole), hookPlan!, inputs));
    case 'hookOnHook':
      return made(mergeMixedHooks(hooks, hookMaxNote, inputs));
    case 'hookOnStyle':
      return made(drapePair(hooks, style!, hookMaxNote, inputs, 'a hook on the style rhythm'));
    case 'curatedOnStyle':
      return made(selectInBank(pickCurated(curatedPlans), inputs));
    case 'curatedOnHook': {
      const plan = pickCurated(curatedRemix);
      const melodies = (plan.remix as { entries: readonly Precedent[] }).entries;
      return made(drapePair(melodies, hooks, plan.rule.maxNote ?? DEFAULT_MAX_NOTE, inputs, `a ${plan.bankId} melody on a hook rhythm`));
    }
  }
}

/** The hooks of the section and tempo flagged useRemix (the pool for mixing, as melody or as rhythm). */
function remixableHooks(plan: BankPlan, inputs: Omit<MergeInputs, 'rng'>): readonly Precedent[] {
  const ofSection = (e: Precedent) => e.properties.type !== undefined && TYPE_TO_SEGMENT[e.properties.type] === inputs.segmentType;
  return tempoBank(plan.bankId, inputs.tempo).filter((e) => {
    const p = e.properties as unknown as { tempoMin: number; tempoMax: number };
    return e.properties.useRemix && ofSection(e) && p.tempoMin <= inputs.tempo && inputs.tempo <= p.tempoMax;
  });
}

/** One melody (pitch shape and chords) from `melodies` on one rhythm from `rhythms`, placed up to maxNote; a pair
 *  that cannot be placed is drawn again (both), up to the legacy retry limit. */
function drapePair(melodies: readonly Precedent[], rhythms: readonly Precedent[], maxNote: number, inputs: MergeInputs, what: string): MergedPrecedent {
  const params = { desiredPatternLength: inputs.desiredPatternLength };
  let safety = 0;
  while (true) {
    // Like the legacy merge, a failed placement draws both again.
    const melodic = pickHelperPrecedent(melodies, params, inputs.rng);
    const rhythmic = pickHelperPrecedent(rhythms, params, inputs.rng);
    const draped = drapeAndPlace(rhythmic, melodic, maxNote, undefined);
    if (draped.ok) return draped.merged;
    if (safety++ > MAX_MERGE_RETRIES) {
      throw new Error(`vocals/precedents: ${what} ("${melodic.id}" on "${rhythmic.id}"): ${draped.failure} after ${safety} retries (${where(inputs)})`);
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
  /** Every rhythm note gets a pitch (lyrics first: each note carries a syllable). Where the legacy lookup finds none
   *  (no melody note or chord near it), the melody's note nearest in time, the earlier on a tie. */
  everyNote = false,
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
    if (!close && everyNote) {
      const nearest = melodicBeats.reduce((best, b) => (Math.abs(parseFloat(b) - rhythmicBeat) < Math.abs(parseFloat(best) - rhythmicBeat) ? b : best));
      merged.melody[getBeatString(rhythmicBeat)] = [{ midi: melodicPrecedent.melody[nearest]![0]!.midi, duration: notes[0]!.duration }];
      lastMidi = merged.melody[getBeatString(rhythmicBeat)]![0]!.midi;
      continue;
    }
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
      rhythmic: rhythmicPrecedent,
      melodic: melodicPrecedent,
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

// ---- a rhythm on its own (lyrics first) ----
//
// With written words, the rhythm and the melody are drawn apart (docs/superpowers/specs/
// 2026-11-27-lyrics-first-singing-design.md): the rhythm uniformly from every rhythm the recipes draw rhythms from,
// the melody as before (selectMergedPrecedent, its `melodic`), then the melody laid on the rhythm the words bent.

/** Every rhythm for the section: the rule's style rhythmic bank (its useRemix entries that suit the tempo), the
 *  hooks written for the section that suit the tempo and may be remixed, and, for a rule with no rhythmic bank (the
 *  legacy merge then takes its rhythm from the melodic bank), the melodic banks' useRemix entries. Only entries that
 *  can be shaped to the section's length (pickHelperPrecedent's window). An error when there is none. */
export function rhythmPool(inputs: Omit<MergeInputs, 'rng'>): readonly Precedent[] {
  const rule = lookupRule(inputs);
  if (!rule) throw new Error(`vocals/precedents: no rhythm for ${inputs.genre}/${inputs.segmentType}: the bank index has no rule for it`);
  const index = loadBankIndex();
  const bankIds = typeof rule.melodic === 'string' ? [rule.melodic] : rule.melodic;
  const hooksId = index.hooks?.bank;
  const pool: Precedent[] = [...(styleRhythms(rule, inputs.tempo) ?? [])];
  if (hooksId !== undefined && bankIds.includes(hooksId)) pool.push(...remixableHooks(planBank(rule, hooksId, inputs), inputs));
  if (!rule.rhythmic) for (const id of bankIds.filter((b) => b !== hooksId)) pool.push(...remixable(tempoBank(id, inputs.tempo)));
  const desired = inputs.desiredPatternLength;
  const lengths = pool.map((e) => e.properties.end - e.properties.start);
  // pickHelperPrecedent's choice: entries no longer than the section and at least half of it; if every entry is
  // longer, any (it is cut).
  const shaped = lengths.some((l) => desired >= l) ? pool.filter((_, i) => desired >= lengths[i]! && desired <= 2 * lengths[i]!) : pool;
  if (shaped.length === 0) throw new Error(`vocals/precedents: no rhythm of a length for ${desired} bars (${where(inputs)})`);
  return shaped;
}

/** One rhythm drawn uniformly from rhythmPool, shaped to the section's length. */
export function drawRhythm(inputs: MergeInputs): Precedent {
  return pickHelperPrecedent(rhythmPool(inputs), { desiredPatternLength: inputs.desiredPatternLength }, inputs.rng);
}

/** The melody's pitches (and its chords) laid on this rhythm and placed up to maxNote, every rhythm note with a pitch.
 *  An error when the two differ in length or the melody cannot be placed (no redraw: the caller chose both). */
export function drapeOnRhythm(rhythm: Precedent, melodic: Precedent, maxNote: number): MergedPrecedent {
  const bars = (p: Precedent) => p.properties.end - p.properties.start;
  if (bars(rhythm) !== bars(melodic)) throw new Error(`vocals/precedents: the rhythm "${rhythm.id}" is ${bars(rhythm)} bars, the melody "${melodic.id}" ${bars(melodic)}`);
  const draped = drapeAndPlace(rhythm, melodic, maxNote, undefined, true);
  if (!draped.ok) throw new Error(`vocals/precedents: the melody "${melodic.id}" on the rhythm "${rhythm.id}": ${draped.failure}`);
  return draped.merged;
}
