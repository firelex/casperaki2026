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
// Register: the banks store melodies an octave below sung pitch (midi 48 is written "c4"). The library shows and
// plays them one octave up (midi + 12), so they read and sound like a sung melody: every pitch leaving here is +12.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** The precedent banks of the arrangement package. */
export const PRECEDENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/arrangement/data/vocals/precedents');

export const HOOKS_BANK = 'hooks';
const HOOKS_FILE = 'mlDataRaw-hooks.json';
/** Bank pitches are an octave below sung pitch; the library shows them as sung (see the header). */
const SUNG_OCTAVE = 12;
/** A remix pattern matches a tempo filter within this many bpm of its own tempo (hooks: inside their range). */
export const REMIX_TEMPO_WINDOW = 10;

export type MelodyKind = 'hooks' | 'remix';

export class MelodyLibraryError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BeatKey = z.string().regex(/^-?\d+(?:\.\d+)?$/u);
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
      })
      .passthrough(),
    melody: z.record(BeatKey, z.array(z.object({ midi: z.number().int(), duration: z.number().positive() }).passthrough()).min(1)),
    chords: z.record(BeatKey, z.object({ chord: z.string().min(1) }).passthrough()),
  })
  .passthrough();
const BankSchema = z.array(EntrySchema).min(1);
const IndexSchema = z.object({ banks: z.record(z.string(), z.object({ file: z.string().min(1) }).passthrough()) }).passthrough();

type RawEntry = z.infer<typeof EntrySchema>;

export interface MelodyListItem {
  readonly bank: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly tempo: number;
  readonly tempoMin?: number;
  readonly tempoMax?: number;
  readonly feel?: string;
  /** Bars including a lead-in bar (properties.end). */
  readonly bars: number;
  /** Sung pitch (bank pitch + 12). */
  readonly lowestNote: number;
  readonly highestNote: number;
  readonly busyness: number;
}

export interface MelodyEntry extends MelodyListItem {
  /** Bars before the 8 bars proper (properties.start: 0, or 1 for a lead-in bar). */
  readonly leadInBars: number;
  /** Notes in beats from the start (4 per bar), sung pitch. */
  readonly melody: readonly { beat: number; midi: number; duration: number }[];
  /** The chord at the start of every half bar (bars x 2). */
  readonly chords: readonly string[];
}

interface Bank {
  readonly id: string;
  readonly items: readonly MelodyListItem[];
  readonly entries: ReadonlyMap<string, RawEntry>;
}

export interface MelodyQuery {
  readonly kind: MelodyKind;
  readonly bank?: string | undefined;
  readonly type?: string | undefined;
  readonly tempo?: number | undefined;
  readonly feel?: string | undefined;
  readonly q?: string | undefined;
  readonly offset: number;
  readonly limit: number;
}

export interface MelodyListResult {
  readonly total: number;
  readonly items: readonly MelodyListItem[];
  /** Hooks only: the hooks bank file does not exist yet. */
  readonly noHooksYet?: true;
  /** The choices of this kind's filters (over the whole kind, not the filtered list). */
  readonly facets: { readonly types: readonly string[]; readonly banks: readonly string[]; readonly feels: readonly string[] };
}

/** The legacy banks spell the pre-chorus two ways; the library shows one. */
const typeOf = (t: string) => (t === 'Prechorus' ? 'Pre-chorus' : t);

function tempoOf(bank: string, e: RawEntry): number {
  const t = Number(e.properties.tempo);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`melody library: ${bank}/${e.id} has no usable tempo (${JSON.stringify(e.properties.tempo)})`);
  return t;
}

function itemOf(bank: string, e: RawEntry): MelodyListItem {
  const p = e.properties;
  const isHook = bank === HOOKS_BANK;
  if (isHook && (p.kind !== 'hook' || p.tempoMin === undefined || p.tempoMax === undefined || p.feel === undefined)) {
    throw new Error(`melody library: hook ${e.id} lacks kind "hook", tempoMin, tempoMax or feel`);
  }
  return {
    bank,
    id: String(e.id),
    name: p.name,
    type: typeOf(p.type),
    tempo: tempoOf(bank, e),
    ...(isHook ? { tempoMin: p.tempoMin!, tempoMax: p.tempoMax!, feel: p.feel! } : {}),
    bars: p.end,
    lowestNote: p.lowestNote + SUNG_OCTAVE,
    highestNote: p.highestNote + SUNG_OCTAVE,
    busyness: p.busyness,
  };
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)];

export class MelodyLibrary {
  private readonly files = new Map<string, { mtimeMs: number; value: unknown }>();

  constructor(private readonly dir: string = PRECEDENTS_DIR) {}

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

  private banksCache = new WeakMap<object, Bank>();

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
      entries.set(key, e);
    }
    const bank: Bank = { id, items: parsed.data.map((e) => itemOf(id, e)), entries };
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

  list(query: MelodyQuery): MelodyListResult {
    const { kind } = query;
    if (kind === 'hooks' && query.bank !== undefined) throw new MelodyLibraryError(400, 'invalid_query', 'bank: hooks have one bank; filter remix patterns by bank.');
    if (kind === 'remix' && query.feel !== undefined) throw new MelodyLibraryError(400, 'invalid_query', 'feel: only hooks have a feel.');
    const hooks = kind === 'hooks' ? this.hooksBank() : undefined;
    if (kind === 'hooks' && !hooks) return { total: 0, items: [], noHooksYet: true, facets: { types: [], banks: [], feels: [] } };
    const banks = kind === 'hooks' ? [hooks!] : this.remixBanks();
    if (query.bank !== undefined && !banks.some((b) => b.id === query.bank)) {
      throw new MelodyLibraryError(400, 'unknown_bank', `bank: no remix bank "${query.bank}" (banks: ${banks.map((b) => b.id).join(', ')}).`);
    }
    const all = banks.flatMap((b) => b.items);
    const q = query.q?.trim().toLowerCase();
    const hits = all.filter(
      (i) =>
        (query.bank === undefined || i.bank === query.bank) &&
        (query.type === undefined || i.type === query.type) &&
        (query.feel === undefined || i.feel === query.feel) &&
        (query.tempo === undefined ||
          (kind === 'hooks' ? query.tempo >= i.tempoMin! && query.tempo <= i.tempoMax! : Math.abs(i.tempo - query.tempo) <= REMIX_TEMPO_WINDOW)) &&
        (!q || i.name.toLowerCase().includes(q) || i.id.toLowerCase() === q),
    );
    return {
      total: hits.length,
      items: hits.slice(query.offset, query.offset + query.limit),
      facets: {
        types: uniq(all.map((i) => i.type)).sort(),
        banks: kind === 'remix' ? banks.map((b) => b.id) : [],
        feels: kind === 'hooks' ? uniq(all.map((i) => i.feel!)).sort() : [],
      },
    };
  }

  entry(bankId: string, id: string): MelodyEntry {
    let bank: Bank | undefined;
    if (bankId === HOOKS_BANK) {
      bank = this.hooksBank();
      if (!bank) throw new MelodyLibraryError(404, 'not_found', 'No hooks yet: the hooks bank has not been written.');
    } else {
      bank = this.remixBanks().find((b) => b.id === bankId);
      if (!bank) throw new MelodyLibraryError(404, 'not_found', `No melody bank "${bankId}".`);
    }
    const e = bank.entries.get(id);
    if (!e) throw new MelodyLibraryError(404, 'not_found', `No entry "${id}" in the ${bankId} bank.`);
    const item = bank.items.find((i) => i.id === id)!;
    const melody = Object.entries(e.melody)
      .flatMap(([beat, notes]) => notes.map((n) => ({ beat: Number(beat), midi: n.midi + SUNG_OCTAVE, duration: n.duration })))
      .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
    const chordAt = new Map(Object.entries(e.chords).map(([beat, c]) => [Number(beat), c.chord]));
    const chords = Array.from({ length: item.bars * 2 }, (_, s) => {
      const c = chordAt.get(s * 2);
      if (c === undefined) throw new Error(`melody library: ${bankId}/${id} has no chord at beat ${s * 2} (half bar ${s + 1})`);
      return c;
    });
    return { ...item, leadInBars: e.properties.start, melody, chords };
  }
}
