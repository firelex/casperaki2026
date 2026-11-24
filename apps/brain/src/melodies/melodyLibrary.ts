// The melody library (read-only): every entry of the vocal precedent banks, for the Melodies page.
//
// Two kinds (docs/superpowers/specs/2026-11-24-hook-library-design.md, "Melody library page"):
//   - hooks: the bank file mlDataRaw-hooks.json, our own melodies (properties.kind "hook", tempoMin, tempoMax, feel).
//     It is not listed in bank-index.json until the owner has auditioned the hooks, so it is read by its file name.
//     A missing file is an expected state ("no hooks yet"), not an error.
//   - remix: every other bank listed in bank-index.json "banks" (the legacy banks, transcriptions of real songs).
//
// The bank format is documented at the top of packages/arrangement/src/vocals/precedents.ts. The files are re-read
// when they change on disk (the hooks are being written while the brain runs).
//
// Edits (melodyEdits.ts) are shown in place of the stored entry, marked "edited". Saving builds the whole entry with the
// arrangement's precedentEntryFromNotes, checks it with checkPrecedentEntry (problems in words refuse the save) and
// stores it; the arrangement then uses it at once (setPrecedentEdits, wired in bootstrap.ts).
//
// Register: the banks store melodies an octave below sung pitch (midi 48 is written "c4"). The library shows and
// plays them one octave up (midi + 12), so they read and sound like a sung melody: every pitch leaving here is +12.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { checkPrecedentEntry, precedentEntryFromNotes, type Precedent } from '@casperaki/arrangement';

import { editKey, type MelodyEdits, type StoredEdit } from './melodyEdits.js';

/** The precedent banks of the arrangement package. */
export const PRECEDENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/arrangement/data/vocals/precedents');

export const HOOKS_BANK = 'hooks';
const HOOKS_FILE = 'mlDataRaw-hooks.json';
/** Bank pitches are an octave below sung pitch; the library shows them as sung (see the header). */
export const SUNG_OCTAVE = 12;
/** A remix pattern matches a tempo filter within this many bpm of its own tempo (hooks: inside their range). */
export const REMIX_TEMPO_WINDOW = 10;

export type MelodyKind = 'hooks' | 'remix';

export class MelodyLibraryError extends Error {
  constructor(
    readonly status: 400 | 404 | 422,
    readonly code: string,
    message: string,
    /** A refused save: what is wrong with the entry, in words. */
    readonly problems?: readonly string[],
  ) {
    super(message);
  }
}

const BeatKey = z.string().regex(/^-?\d+(?:\.\d+)?$/u);
const SourceSchema = z.object({ kind: z.enum(['song', 'melodySauce', 'casperaki']), title: z.string().optional(), artist: z.string().optional() }).strict();
const EntrySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    properties: z
      .object({
        name: z.string().min(1),
        tempo: z.union([z.string(), z.number()]),
        busyness: z.number(),
        type: z.string().min(1),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        lowestNote: z.number(),
        highestNote: z.number(),
        kind: z.literal('hook').optional(),
        tempoMin: z.number().positive().optional(),
        tempoMax: z.number().positive().optional(),
        feel: z.string().min(1).optional(),
        style: z.string().min(1).optional(),
        substyle: z.string().min(1).optional(),
        source: SourceSchema,
        useOriginal: z.boolean(),
        useRemix: z.boolean(),
      })
      .passthrough(),
    melody: z.record(BeatKey, z.array(z.object({ midi: z.number().int(), duration: z.number().positive() }).passthrough()).min(1)),
    chords: z.record(BeatKey, z.object({ chord: z.string().min(1) }).passthrough()),
  })
  .passthrough();
const BankSchema = z.array(EntrySchema).min(1);
const IndexSchema = z.object({ banks: z.record(z.string(), z.object({ file: z.string().min(1) }).passthrough()) }).passthrough();

type RawEntry = z.infer<typeof EntrySchema>;
export type MelodySource = z.infer<typeof SourceSchema>;

export interface MelodyListItem {
  readonly bank: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly tempo: number;
  readonly tempoMin?: number;
  readonly tempoMax?: number;
  readonly feel?: string;
  /** Hooks: the song style it was written for (a genre id); absent for hooks written for no particular style. */
  readonly style?: string;
  /** Hooks: the narrower style within it (e.g. disco, afrobeats). */
  readonly substyle?: string;
  /** Bars including a lead-in bar (properties.end). */
  readonly bars: number;
  /** Sung pitch (bank pitch + 12). */
  readonly lowestNote: number;
  readonly highestNote: number;
  readonly busyness: number;
  /** Highest minus lowest note, in semitones. */
  readonly range: number;
  /** Where the melody comes from (a real song, Melody Sauce, or our own). */
  readonly source: MelodySource;
  /** Used whole, exactly as written. */
  readonly useOriginal: boolean;
  /** Used in mixing (rhythm of one entry, shape and chords of another). */
  readonly useRemix: boolean;
  /** Shown as edited on the Melodies page (the stored version is kept). */
  readonly edited: boolean;
  readonly editedAt?: string;
  readonly editedBy?: string;
}

export interface MelodyEntry extends MelodyListItem {
  /** Bars before the 8 bars proper (properties.start: 0, or 1 for a lead-in bar). */
  readonly leadInBars: number;
  /** Notes in beats from the start (4 per bar), sung pitch. */
  readonly melody: readonly { beat: number; midi: number; duration: number }[];
  /** The chord at the start of every half bar (bars x 2); empty for an entry without chords (the rhythmic banks). */
  readonly chords: readonly string[];
}

/** What the page saves: the whole edited entry, at sung pitch, one chord per half bar. */
export interface MelodySave {
  readonly melody: readonly { beat: number; midi: number; duration: number }[];
  readonly chords: readonly string[];
  /** The artist of the source (the admin knows the origin); empty removes it. */
  readonly artist: string;
  readonly useOriginal: boolean;
  readonly useRemix: boolean;
}

interface Bank {
  readonly id: string;
  readonly entries: ReadonlyMap<string, RawEntry>;
}

export interface MelodyQuery {
  readonly kind: MelodyKind;
  readonly source?: MelodySource['kind'] | undefined;
  readonly range?: MelodyRange | undefined;
  readonly type?: string | undefined;
  readonly tempo?: number | undefined;
  readonly feel?: string | undefined;
  /** Hooks: a style (genre id), or 'none' for hooks written for no particular style. */
  readonly style?: string | undefined;
  readonly substyle?: string | undefined;
  readonly q?: string | undefined;
  /** Only entries with useOriginal on (true) or off (false). */
  readonly original?: boolean | undefined;
  /** Only entries with useRemix on (true) or off (false). */
  readonly remix?: boolean | undefined;
  readonly offset: number;
  readonly limit: number;
}

export interface MelodyListResult {
  readonly total: number;
  readonly items: readonly MelodyListItem[];
  /** Hooks only: the hooks bank file does not exist yet. */
  readonly noHooksYet?: true;
  /** The choices of this kind's filters (over the whole kind, not the filtered list). */
  readonly facets: { readonly types: readonly string[]; readonly sources: readonly MelodySource['kind'][]; readonly feels: readonly string[]; readonly styles: readonly string[]; readonly substyles: readonly string[] };
}

/** The range filter: narrow up to 9 semitones, medium 10-14, wide 15 and more. */
export type MelodyRange = 'narrow' | 'medium' | 'wide';
export const rangeOf = (semitones: number): MelodyRange => (semitones <= 9 ? 'narrow' : semitones <= 14 ? 'medium' : 'wide');

/** The legacy banks spell the pre-chorus two ways; the library shows one. */
const typeOf = (t: string) => (t === 'Prechorus' ? 'Pre-chorus' : t);

function tempoOf(bank: string, e: RawEntry): number {
  const t = Number(e.properties.tempo);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`melody library: ${bank}/${e.id} has no usable tempo (${JSON.stringify(e.properties.tempo)})`);
  return t;
}

/** Notes of an entry in beats, in the bank register. */
function notesOf(e: Pick<RawEntry, 'melody'>): { beat: number; midi: number; duration: number }[] {
  return Object.entries(e.melody)
    .flatMap(([beat, notes]) => notes.map((n) => ({ beat: Number(beat), midi: n.midi, duration: n.duration })))
    .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}

/** The chord at the start of every half bar; none for an entry without chords (the rhythmic banks). */
function halfBarChords(where: string, e: Pick<RawEntry, 'chords'>, bars: number): string[] {
  if (Object.keys(e.chords).length === 0) return [];
  const chordAt = new Map(Object.entries(e.chords).map(([beat, c]) => [Number(beat), c.chord]));
  return Array.from({ length: bars * 2 }, (_, s) => {
    const c = chordAt.get(s * 2);
    if (c === undefined) throw new Error(`melody library: ${where} has no chord at beat ${s * 2} (half bar ${s + 1})`);
    return c;
  });
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)];

/**
 * The arrangement's precedentEntryFromNotes (melody in the bank format, statistics recomputed). An entry without chords
 * (`halfBars` empty) stays without: the builder is given a placeholder chord per half bar, and its chords are dropped.
 */
function buildEntry(base: RawEntry, notes: readonly { beat: number; midi: number; duration: number }[], halfBars: readonly string[]): Precedent {
  if (halfBars.length > 0) return precedentEntryFromNotes(base as Precedent, notes, halfBars);
  const built = precedentEntryFromNotes(base as Precedent, notes, Array.from({ length: base.properties.end * 2 }, () => 'C'));
  return { ...built, chords: {} };
}

export class MelodyLibrary {
  private readonly files = new Map<string, { mtimeMs: number; value: unknown }>();
  private readonly banksCache = new WeakMap<object, Bank>();

  constructor(
    private readonly edits: MelodyEdits,
    private readonly dir: string = PRECEDENTS_DIR,
  ) {}

  /** Parsed JSON of a file in the directory, re-read when it changes. */
  private json(file: string): unknown {
    const path = resolve(this.dir, file);
    const { mtimeMs } = statSync(path);
    const cached = this.files.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    this.files.set(file, { mtimeMs, value });
    return value;
  }

  private bank(id: string, file: string): Bank {
    const raw = this.json(file);
    const hit = this.banksCache.get(raw as object);
    if (hit) return hit;
    const parsed = BankSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`melody library: ${file} is not a valid precedent bank: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
    const entries = new Map<string, RawEntry>();
    for (const e of parsed.data) {
      const key = String(e.id);
      if (entries.has(key)) throw new Error(`melody library: ${file} has the id ${key} twice`);
      if (id === HOOKS_BANK && (e.properties.kind !== 'hook' || e.properties.tempoMin === undefined || e.properties.tempoMax === undefined || e.properties.feel === undefined)) {
        throw new Error(`melody library: hook ${key} lacks kind "hook", tempoMin, tempoMax or feel`);
      }
      entries.set(key, e);
    }
    const bank: Bank = { id, entries };
    this.banksCache.set(raw as object, bank);
    return bank;
  }

  /** The remix banks: every bank of the index except the hooks, in index order. */
  private remixBanks(): Bank[] {
    const index = IndexSchema.parse(this.json('bank-index.json'));
    return Object.entries(index.banks)
      .filter(([id, b]) => id !== HOOKS_BANK && b.file !== HOOKS_FILE)
      .map(([id, b]) => this.bank(id, b.file));
  }

  /** The hooks bank, or undefined while its file does not exist (no hooks written yet). */
  private hooksBank(): Bank | undefined {
    return existsSync(resolve(this.dir, HOOKS_FILE)) ? this.bank(HOOKS_BANK, HOOKS_FILE) : undefined;
  }

  /** The bank of an entry; 404 when there is none. */
  private bankOf(bankId: string): Bank {
    if (bankId === HOOKS_BANK) {
      const b = this.hooksBank();
      if (!b) throw new MelodyLibraryError(404, 'not_found', 'No hooks yet: the hooks bank has not been written.');
      return b;
    }
    const b = this.remixBanks().find((x) => x.id === bankId);
    if (!b) throw new MelodyLibraryError(404, 'not_found', `No melody bank "${bankId}".`);
    return b;
  }

  /** The stored entry (as in the bank file); 404 when there is none. */
  private stored(bankId: string, id: string): RawEntry {
    const e = this.bankOf(bankId).entries.get(id);
    if (!e) throw new MelodyLibraryError(404, 'not_found', `No entry "${id}" in the ${bankId} bank.`);
    return e;
  }

  /** The entry as shown: the saved edit over the stored entry (statistics recomputed), or the stored entry. */
  private current(bank: string, e: RawEntry): { entry: RawEntry; edit: StoredEdit | undefined } {
    const edit = this.edits.get(bank, String(e.id));
    if (!edit) return { entry: e, edit };
    const built = buildEntry(e, notesOf(edit), halfBarChords(editKey(bank, String(e.id)), edit, e.properties.end));
    const entry = EntrySchema.parse({
      ...built,
      melody: edit.melody,
      chords: edit.chords,
      properties: { ...built.properties, useOriginal: edit.useOriginal, useRemix: edit.useRemix, source: edit.source },
    });
    return { entry, edit };
  }

  private itemOf(bank: string, raw: RawEntry): MelodyListItem {
    const { entry: e, edit } = this.current(bank, raw);
    const p = e.properties;
    return {
      bank,
      id: String(e.id),
      name: p.name,
      type: typeOf(p.type),
      tempo: tempoOf(bank, e),
      ...(bank === HOOKS_BANK ? { tempoMin: p.tempoMin!, tempoMax: p.tempoMax!, feel: p.feel!, ...(p.style ? { style: p.style } : {}), ...(p.substyle ? { substyle: p.substyle } : {}) } : {}),
      bars: p.end,
      lowestNote: p.lowestNote + SUNG_OCTAVE,
      highestNote: p.highestNote + SUNG_OCTAVE,
      busyness: p.busyness,
      range: p.highestNote - p.lowestNote,
      source: p.source,
      useOriginal: p.useOriginal,
      useRemix: p.useRemix,
      edited: edit !== undefined,
      ...(edit ? { editedAt: edit.editedAt, editedBy: edit.editedBy } : {}),
    };
  }

  list(query: MelodyQuery): MelodyListResult {
    const { kind } = query;
    if (kind === 'remix' && query.feel !== undefined) throw new MelodyLibraryError(400, 'invalid_query', 'feel: only hooks have a feel.');
    if (kind === 'remix' && query.style !== undefined) throw new MelodyLibraryError(400, 'invalid_query', 'style: only hooks have a style.');
    if (kind === 'remix' && query.substyle !== undefined) throw new MelodyLibraryError(400, 'invalid_query', 'substyle: only hooks have a substyle.');
    const hooks = kind === 'hooks' ? this.hooksBank() : undefined;
    if (kind === 'hooks' && !hooks) return { total: 0, items: [], noHooksYet: true, facets: { types: [], sources: [], feels: [], styles: [], substyles: [] } };
    const banks = kind === 'hooks' ? [hooks!] : this.remixBanks();
    const all = banks.flatMap((b) => [...b.entries.values()].map((e) => this.itemOf(b.id, e)));
    const q = query.q?.trim().toLowerCase();
    const hits = all.filter(
      (i) =>
        (query.source === undefined || i.source.kind === query.source) &&
        (query.range === undefined || rangeOf(i.range) === query.range) &&
        (query.type === undefined || i.type === query.type) &&
        (query.feel === undefined || i.feel === query.feel) &&
        (query.substyle === undefined || i.substyle === query.substyle) &&
        (query.style === undefined || (query.style === 'none' ? i.style === undefined : i.style === query.style)) &&
        (query.original === undefined || i.useOriginal === query.original) &&
        (query.remix === undefined || i.useRemix === query.remix) &&
        (query.tempo === undefined ||
          (kind === 'hooks' ? query.tempo >= i.tempoMin! && query.tempo <= i.tempoMax! : Math.abs(i.tempo - query.tempo) <= REMIX_TEMPO_WINDOW)) &&
        (!q || i.name.toLowerCase().includes(q) || i.id.toLowerCase() === q || (i.source.title ?? '').toLowerCase().includes(q) || (i.source.artist ?? '').toLowerCase().includes(q) || (i.feel ?? '').toLowerCase().includes(q) || (i.style ?? '').toLowerCase().includes(q) || (i.substyle ?? '').toLowerCase().includes(q)),
    );
    return {
      total: hits.length,
      items: hits.slice(query.offset, query.offset + query.limit),
      facets: {
        types: uniq(all.map((i) => i.type)).sort(),
        sources: uniq(all.map((i) => i.source.kind)).sort() as MelodySource['kind'][],
        feels: kind === 'hooks' ? uniq(all.map((i) => i.feel!)).sort() : [],
        styles: kind === 'hooks' ? uniq(all.flatMap((i) => (i.style ? [i.style] : []))).sort() : [],
        substyles: kind === 'hooks' ? uniq(all.flatMap((i) => (i.substyle ? [i.substyle] : []))).sort() : [],
      },
    };
  }

  entry(bankId: string, id: string): MelodyEntry {
    const raw = this.stored(bankId, id);
    const item = this.itemOf(bankId, raw);
    const { entry: e } = this.current(bankId, raw);
    return {
      ...item,
      leadInBars: e.properties.start,
      melody: notesOf(e).map((n) => ({ ...n, midi: n.midi + SUNG_OCTAVE })),
      chords: halfBarChords(editKey(bankId, id), e, item.bars),
    };
  }

  /**
   * Saves an edited entry: built from the stored entry with the page's notes (sung pitch, stored an octave lower) and
   * half-bar chords, checked by the arrangement (problems in words refuse it, 422). A half bar whose chord is the
   * stored one keeps the stored beat-by-beat chords.
   */
  save(bankId: string, id: string, input: MelodySave, editedBy: string): MelodyEntry {
    const raw = this.stored(bankId, id);
    const bars = raw.properties.end;
    const storedHalfBars = halfBarChords(editKey(bankId, id), raw, bars);
    const want = storedHalfBars.length === 0 ? 0 : bars * 2;
    if (input.chords.length !== want) {
      throw new MelodyLibraryError(
        400,
        'invalid_body',
        want === 0 ? `chords: ${bankId}/${id} has no chords, got ${input.chords.length}.` : `chords: ${bankId}/${id} has ${bars} bars, so ${want} half-bar chords are needed, got ${input.chords.length}.`,
      );
    }
    if (input.melody.length === 0) throw new MelodyLibraryError(422, 'invalid_entry', 'The edit was not saved: the melody has no notes', ['the melody has no notes']);
    const notes = input.melody.map((n) => ({ beat: n.beat, midi: n.midi - SUNG_OCTAVE, duration: n.duration }));
    const built = buildEntry(raw, notes, [...input.chords]);
    const chords: Record<string, { chord: string }> = { ...(built.chords as Record<string, { chord: string }>) };
    for (const [beat, c] of Object.entries(raw.chords)) {
      const slot = Math.floor(Number(beat) / 2);
      if (input.chords[slot] === storedHalfBars[slot]) chords[beat] = { chord: c.chord };
    }
    const artist = input.artist.trim();
    const { artist: _old, ...sourceRest } = raw.properties.source;
    const source: MelodySource = artist ? { ...sourceRest, artist } : sourceRest;
    const entry = {
      ...built,
      chords,
      properties: { ...built.properties, source, useOriginal: input.useOriginal, useRemix: input.useRemix },
    } as Precedent;
    const problems = checkPrecedentEntry(entry, bankId === HOOKS_BANK ? 'hook' : 'legacy');
    if (problems.length > 0) throw new MelodyLibraryError(422, 'invalid_entry', `The edit was not saved: ${problems.join('; ')}`, problems);
    this.edits.set(bankId, id, {
      melody: entry.melody as StoredEdit['melody'],
      chords,
      useOriginal: input.useOriginal,
      useRemix: input.useRemix,
      source,
      editedAt: new Date().toISOString(),
      editedBy,
    });
    return this.entry(bankId, id);
  }

  /** Back to the stored version (404 when the entry has no edit). */
  revert(bankId: string, id: string, by: string): MelodyEntry {
    this.stored(bankId, id);
    if (!this.edits.remove(bankId, id, by)) throw new MelodyLibraryError(404, 'not_edited', `${bankId}/${id} has no edit.`);
    return this.entry(bankId, id);
  }
}
