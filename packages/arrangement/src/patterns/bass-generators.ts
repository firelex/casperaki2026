// Real legacy bass pattern generators (to-do #2).
//
// The rebuild originally lowered every genre through the orphan SM
// (Simple/Manual) banks (bass-bank.ts). Legacy
// `config.json#defaultStyleMappings.bassPatterns` never selects an `*SM`
// style — it maps genres to the real generators:
//
//   simple                  -> SimpleBass        (ballad / brightPop / organicVibes)
//   edmSimple / edmComplex  -> EDMBass           (edm / schlager)
//   latin/brightPop/        -> LibraryBass       (pre-baked MIDI banks)
//     organicVibes/rock
//   urban                   -> HipHopBass        (derived from the drum pattern)
//
// Generators come in two emission flavours, modelled by the
// `RealBassSelection` union the bass.ts emit loop branches on:
//
//   - `chordRelative` — SimpleBass / edmSimple / HipHop: an ordered list of
//     `[position, duration, semitoneOffset]` triples played against the
//     chord root at `rootMidiOctave`. (SimpleBass/HipHop: root only, offset 0;
//     edmSimple carries the absolute octave in the offset over rootMidiOctave
//     -1.)
//   - `absolute` — edmComplex / Library: pre-baked, chord-independent MIDI
//     events (octave-centred bank patterns), repeated modulo patternBars.
//
// Phases 1-2 port SimpleBass, edmSimple, edmComplex and the four Library
// banks; HipHop (urban) still uses the SM fallback until phase 3.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import type { ScaleMode } from '@casperaki/music-theory';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import type { BassHit, BassPattern } from './bass-bank.js';
import type { FamilyPattern } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'bass');

/** One chord-independent bass note event (absolute MIDI). */
export interface AbsBassEvent {
  readonly bar: number;
  readonly beat: number;
  readonly midi: number;
  readonly duration: number;
}

/** A generator result the bass.ts emit loop branches on by `mode`. */
export type RealBassSelection =
  | {
      readonly mode: 'chordRelative';
      readonly styleName: string;
      readonly patternIndex: number;
      readonly pattern: BassPattern;
      readonly patternBars: number;
      readonly rootMidiOctave: number;
    }
  | {
      readonly mode: 'absolute';
      readonly styleName: string;
      readonly patternIndex: number;
      readonly events: readonly AbsBassEvent[];
      readonly patternBars: number;
    };

// ---------------------------------------------------------------------------
// SimpleBass — SimpleBassPatternGeneratorClass.js
// ---------------------------------------------------------------------------
// 20 hard-coded two-bar patterns of `[position, duration]` pairs. The note is
// always the chord root at octave 2 (legacy `getChordBaseNote(chord) + '2'`),
// so the semitone offset is 0 and rootMidiOctave is 2. Busyness filters the
// pool by hit-count: 1 -> <= 8, 2 -> 4..10, 3 -> >= 6.

const SIMPLE_BASS_PATTERNS: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 0.5], [6.5, 0.5], [7, 0.5], [7.5, 0.5]],
  [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6.5, 0.5], [7, 0.5]],
  [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [3.5, 0.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [7.5, 0.5]],
  [[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 0.5], [6.5, 0.5], [7, 1]],
  [[0, 0.75], [0.75, 0.25], [1, 0.5], [1.5, 1], [2.5, 0.5], [3, 0.25], [3.25, 0.75], [4, 0.75], [4.75, 0.25], [5, 0.5], [5.5, 1], [6.5, 0.5], [7, 0.25], [7.25, 0.75]],
  [[0, 1], [1, 1], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5], [4, 1], [5, 1], [6, 0.5], [6.5, 0.5], [7, 0.5], [7.5, 0.5]],
  [[0, 1], [1, 1], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5], [4, 1], [5, 1], [6, 0.5], [6.5, 0.5], [7, 1]],
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1]],
  [[0, 0.5], [1.5, 0.5], [3, 1], [4, 0.5], [5.5, 0.5], [7, 1]],
  [[0, 1], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3.5, 0.5], [5.5, 0.5], [6, 1], [7, 1]],
  [[0, 1.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [4, 0.5], [4.5, 1], [5.5, 0.5], [6, 0.5], [6.5, 0.5], [7, 0.5], [7, 0.5]],
  [[0, 1.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [4, 1.5], [5.5, 0.5], [6, 0.5], [6.5, 0.5]],
  [[0, 1.5], [1.5, 0.5], [2, 1.5], [3.5, 0.5], [4, 1.5], [5.5, 0.5], [6, 0.5], [6.5, 0.5], [7, 0.5], [7.5, 0.5]],
  [[0, 1.5], [1.5, 0.5], [2, 1.5], [3.5, 0.5], [4, 1.5], [5.5, 0.5], [6, 1.5], [7.5, 0.5]],
  [[0, 1.5], [1.5, 0.5], [2, 2.5], [4, 1.5], [5.5, 0.5], [6, 2]],
  [[0, 1.5], [1.5, 2.5], [4, 1.5], [5.5, 2.5]],
  [[0, 4], [4, 4]],
  [[0, 1], [1.25, 0.25], [1.5, 0.5], [3, 0.25], [3.25, 0.75], [4, 1], [5.25, 0.25], [5.5, 0.5], [7, 0.25], [7.25, 0.25], [7.5, 0.5]],
  [[0, 2], [2, 1], [3, 1], [4, 2], [6, 2]],
  [[0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1], [3.5, 0.5], [4, 1], [5, 0.5], [5.5, 1]],
];

/** SimpleBass octave — legacy `getChordBaseNote(chord) + '2'`. */
const SIMPLE_BASS_ROOT_OCTAVE = 2;

function filterByBusyness(
  patterns: typeof SIMPLE_BASS_PATTERNS,
  busyness: 1 | 2 | 3,
): { pattern: (typeof SIMPLE_BASS_PATTERNS)[number]; index: number }[] {
  const out: { pattern: (typeof SIMPLE_BASS_PATTERNS)[number]; index: number }[] = [];
  patterns.forEach((pattern, index) => {
    const n = pattern.length;
    const keep =
      busyness === 1 ? n <= 8 : busyness === 2 ? n >= 4 && n <= 10 : n >= 6;
    if (keep) out.push({ pattern, index });
  });
  return out;
}

/**
 * Pick one SimpleBass pattern for `busyness`, shaped for the bass.ts emit
 * loop. Notes are the chord root at octave 2 (semitone offset 0).
 */
export function selectSimpleBassPattern(rng: Rng, busyness: 1 | 2 | 3): RealBassSelection {
  const pool = filterByBusyness(SIMPLE_BASS_PATTERNS, busyness);
  const choice = rng.pick(pool);
  const pattern: BassPattern = Object.freeze(
    choice.pattern.map(([position, duration]) => Object.freeze([position, duration, 0]) as BassHit),
  );
  return {
    mode: 'chordRelative',
    styleName: 'simple',
    patternIndex: choice.index,
    pattern,
    patternBars: 2,
    rootMidiOctave: SIMPLE_BASS_ROOT_OCTAVE,
  };
}

// ---------------------------------------------------------------------------
// Data-backed banks (edmSimple / edmComplex / Library) — loader
// ---------------------------------------------------------------------------

// edmSimple: array of patterns, each an array of [position, duration, octave]
// triples. The note is the chord root at the per-hit octave (legacy
// `getChordBaseNote(chord) + item[2]`), so it lowers to a chordRelative
// selection with rootMidiOctave -1 and a per-hit semitone offset of
// (octave + 1) * 12.
const PositionalTripleSchema = z
  .tuple([z.number().nonnegative(), z.number().positive(), z.number().int()])
  .rest(z.never());
const PositionalBankSchema = z.array(z.array(PositionalTripleSchema).min(1)).min(1);

// edmComplex / Library: array of patterns carrying scale-specific note banks.
// Each note bank maps a (possibly fractional) absolute beat position to a list
// of `{ note, midi, duration }` notes. The legacy reads the note NAME (its
// table index, MIDI - 12) and falls back to `midi` for names outside its table;
// see selectCenteredBankPattern.
// Data fix (2026-11-22): the Library banks (brightPop / latin / rock /
// organicVibes) carried ~30,000 keyswitch notes recorded with the bass parts:
// octave -1 / 0 (below a bass's lowest string), 1/16 long, always sounding
// with a real note. The legacy played them as notes (sub-audible rumble, and
// they pulled the centring average down); they were removed from the data.
const CenteredNoteSchema = z
  .object({ note: z.string().min(1), midi: z.number().int(), duration: z.number().positive() })
  .passthrough();
const CenteredPatternSchema = z
  .object({
    notesMajor: z.record(z.string(), z.array(CenteredNoteSchema)),
    notesMinor: z.record(z.string(), z.array(CenteredNoteSchema)),
  })
  .passthrough();
const CenteredBankSchema = z.array(CenteredPatternSchema).min(1);

const STYLE_FILE: Readonly<Record<string, string>> = {
  edmSimple: 'edm/edmSimple.json',
  edmComplex: 'edm/edmComplex.json',
  latin: 'library/latin.json',
  brightPop: 'library/brightPop.json',
  organicVibes: 'library/organicVibes.json',
  rock: 'library/rock.json',
};

function bankMeta(style: string): DataAssetMeta {
  return {
    filename: `bass/${STYLE_FILE[style] ?? style}`,
    legacyPath:
      'casperaki2-engine-js/api/v1.0/services/classes/patterns/bassPatterns/elements/',
    extractedAt: '2026-06-16',
  };
}

function loadJson(style: string): unknown {
  const file = STYLE_FILE[style];
  if (!file) throw new DataAssetError(bankMeta(style), `no data file for bass style "${style}"`);
  try {
    return JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8'));
  } catch (err) {
    throw new DataAssetError(bankMeta(style), `failed to load: ${(err as Error).message}`, err);
  }
}

const positionalCache = new Map<string, z.infer<typeof PositionalBankSchema>>();
const centeredCache = new Map<string, z.infer<typeof CenteredBankSchema>>();

function loadPositionalBank(style: string): z.infer<typeof PositionalBankSchema> {
  const hit = positionalCache.get(style);
  if (hit) return hit;
  const parsed = PositionalBankSchema.safeParse(loadJson(style));
  if (!parsed.success) {
    throw new DataAssetError(
      bankMeta(style),
      `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  positionalCache.set(style, parsed.data);
  return parsed.data;
}

function loadCenteredBank(style: string): z.infer<typeof CenteredBankSchema> {
  const hit = centeredCache.get(style);
  if (hit) return hit;
  const parsed = CenteredBankSchema.safeParse(loadJson(style));
  if (!parsed.success) {
    throw new DataAssetError(
      bankMeta(style),
      `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  centeredCache.set(style, parsed.data);
  return parsed.data;
}

/** Test-only — drop the in-memory bank caches so a re-load re-reads disk. */
export function _resetRealBassBankCache(): void {
  positionalCache.clear();
  centeredCache.clear();
}

// ---------------------------------------------------------------------------
// edmSimple — EDMBassPatternGeneratorClass.js (style 'edmSimple')
// ---------------------------------------------------------------------------

/** Pick one edmSimple pattern: chord root at the per-hit octave. */
export function selectEdmSimpleBassPattern(rng: Rng): RealBassSelection {
  const bank = loadPositionalBank('edmSimple');
  const index = rng.int(0, bank.length - 1);
  const raw = bank[index]!;
  // note = chordRoot at octave `oct`  ⇒  with rootMidiOctave -1 (base 0):
  //   (-1+1)*12 + root + offset == root + (oct+1)*12.
  const pattern: BassPattern = Object.freeze(
    raw.map(([position, duration, oct]) =>
      Object.freeze([position, duration, (oct + 1) * 12]) as BassHit,
    ),
  );
  return {
    mode: 'chordRelative',
    styleName: 'edmSimple',
    patternIndex: index,
    pattern,
    patternBars: 2,
    rootMidiOctave: -1,
  };
}

// ---------------------------------------------------------------------------
// Centered-MIDI-bank — edmComplex (EDMBass) + latin/brightPop/organicVibes/
// rock (LibraryBass). Identical algorithm: pick a pattern, take the scale's
// note bank, octave-centre every note by `-averageNoteIndexCNeighbor + 24`
// where averageNoteIndexCNeighbor = round(avgMidi / 12) * 12, with a guard
// that drops it an octave if the lowest note would underflow.
// ---------------------------------------------------------------------------

const CENTERED_BEATS_PER_BAR = 4;
const MIDI_MIN = 0;
const MIDI_MAX = 127;

const LEGACY_PC: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** A note name's index in the legacy note table ('c0' = 0), or undefined when the table has no such note (octave -1). */
function legacyIndex(name: string): number | undefined {
  const m = /^([a-g])(#|b)?(-?\d+)$/u.exec(name.toLowerCase());
  if (!m) throw new Error(`bass bank: unreadable note name "${name}"`);
  const octave = Number(m[3]);
  if (octave < 0) return undefined;
  return octave * 12 + LEGACY_PC[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

export function selectCenteredBankPattern(
  rng: Rng,
  style: string,
  scale: ScaleMode,
): RealBassSelection {
  const bank = loadCenteredBank(style);
  const index = rng.int(0, bank.length - 1);
  const pattern = bank[index]!;
  const noteBank = scale === 'minor' ? pattern.notesMinor : pattern.notesMajor;

  // Legacy LibraryBassPatternGeneratorClass (54-113) works in its note-table
  // indices (index 0 = 'c0', which the engine plays as MIDI 12), read from the
  // note NAME. A name it cannot index (octave -1) falls back to the stored
  // MIDI number ("too low, so we effectively transpose it one octave up"); so
  // does 'c0' when averaging, its index 0 being falsy in JavaScript.
  const all = Object.values(noteBank).flat();
  const statIndex = (n: { note: string; midi: number }) => legacyIndex(n.note) || n.midi;
  const outIndex = (n: { note: string; midi: number }) => legacyIndex(n.note) ?? n.midi;
  let cNeighbor = 0;
  if (all.length > 0) {
    const idx = all.map(statIndex);
    cNeighbor = Math.round(idx.reduce((a, b) => a + b, 0) / idx.length / 12) * 12;
    if (Math.min(...idx) + 24 - cNeighbor < 0) cNeighbor -= 12;
  }

  const events: AbsBassEvent[] = [];
  let lastBeatEnd = 0;
  for (const [hitKey, notes] of Object.entries(noteBank)) {
    const absHit = Number.parseFloat(hitKey);
    if (!Number.isFinite(absHit)) continue;
    const bar = Math.floor(absHit / CENTERED_BEATS_PER_BAR);
    const beat = absHit % CENTERED_BEATS_PER_BAR;
    for (const n of notes) {
      // index + 24 - cNeighbor, then from table index to MIDI (+ 12). (The
      // first port computed midi + 24 - centre in MIDI, an octave low.)
      let midi = outIndex(n) + 24 - cNeighbor + 12;
      while (midi < MIDI_MIN) midi += 12;
      while (midi > MIDI_MAX) midi -= 12;
      events.push({ bar, beat, midi, duration: n.duration });
      if (absHit + n.duration > lastBeatEnd) lastBeatEnd = absHit + n.duration;
    }
  }
  const patternBars = Math.max(1, Math.ceil(lastBeatEnd / CENTERED_BEATS_PER_BAR));
  return {
    mode: 'absolute',
    styleName: style,
    patternIndex: index,
    events: Object.freeze(events),
    patternBars,
  };
}

// ---------------------------------------------------------------------------
// HipHopBass — HipHopBassPatternGeneratorClass.js (style 'urban')
// ---------------------------------------------------------------------------
// Derives a legato bassline from the drum pattern's kick hits: collect the
// bassDrum1/bassDrum2 hit slots over the 2-bar base pattern, pick a
// busyness-scaled random subset, and give each picked note a duration that
// stretches to the NEXT kick (legato), or to the end of the 2 bars for the
// last. The note is the chord root at octave 2 (chordRelative, offset 0).

const HIPHOP_SLOTS_PER_BAR = 32; // legacy 64-step grid over 2 bars
const HIPHOP_SLOTS_PER_BEAT = 8;
const HIPHOP_TOTAL_SLOTS = HIPHOP_SLOTS_PER_BAR * 2;
const KICK_MIDI = new Set([35, 36]); // bassDrum2 (35) + bassDrum1 (36)

/** Collect kick hit slots (0..63) from the first two bars of a drum pattern. */
function kickSlots(drumPattern: FamilyPattern): number[] {
  const slots = new Set<number>();
  const barCount = Math.min(2, drumPattern.bars.length);
  for (let bar = 0; bar < barCount; bar++) {
    const barPat = drumPattern.bars[bar]!;
    for (const [beatKey, events] of Object.entries(barPat.notes)) {
      if (!events) continue;
      const isKick = events.some(
        (e) => e.type === 'note' && typeof e.note === 'number' && KICK_MIDI.has(e.note),
      );
      if (!isKick) continue;
      const beat = Number.parseFloat(beatKey);
      if (!Number.isFinite(beat)) continue;
      slots.add(bar * HIPHOP_SLOTS_PER_BAR + Math.round(beat * HIPHOP_SLOTS_PER_BEAT));
    }
  }
  return [...slots].sort((a, b) => a - b);
}

const HIPHOP_BUSYNESS_FACTOR: Readonly<Record<1 | 2 | 3, number>> = {
  1: 0.75,
  2: 0.87,
  3: 1.0,
};

/**
 * Port of HipHopBassPatternGeneratorClass. Returns a chordRelative selection
 * (root at octave 2). Returns `null` when the drum pattern has no kick hits to
 * derive from (caller falls back to the SM bank).
 */
export function selectHipHopBassPattern(
  rng: Rng,
  drumPattern: FamilyPattern,
  busyness: 1 | 2 | 3,
): RealBassSelection | null {
  const hits = kickSlots(drumPattern);
  if (hits.length === 0) return null;

  const factor = HIPHOP_BUSYNESS_FACTOR[busyness];
  // floor((rand*len + 1) * factor) — always in [0, len] since rand < 1.
  const count = Math.floor((rng.next() * hits.length + 1) * factor);

  const chosen: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let idx: number;
    do {
      idx = rng.int(0, hits.length - 1);
    } while (used.has(idx));
    used.add(idx);
    chosen.push(idx);
  }

  const pattern: BassHit[] = [];
  for (const idx of chosen) {
    const slot = hits[idx]!;
    const nextSlot = idx === hits.length - 1 ? HIPHOP_TOTAL_SLOTS : hits[idx + 1]!;
    const durationSlots = nextSlot - slot;
    const position = slot / HIPHOP_SLOTS_PER_BEAT; // global beat 0..7.999
    const duration = durationSlots / HIPHOP_SLOTS_PER_BEAT; // beats
    pattern.push(Object.freeze([position, duration, 0]) as BassHit);
  }
  // Keep emission order stable (legacy iterates an object keyed by slot).
  pattern.sort((a, b) => a[0] - b[0]);

  return {
    mode: 'chordRelative',
    styleName: 'urban',
    patternIndex: -1,
    pattern: Object.freeze(pattern),
    patternBars: 2,
    rootMidiOctave: 2,
  };
}

// ---------------------------------------------------------------------------
// Dispatch — legacy config.json#defaultStyleMappings.bassPatterns
// ---------------------------------------------------------------------------

/** Legacy genre → bass style pool (canonical rebuild genres only). */
const LEGACY_BASS_GENRE_STYLES: Readonly<Record<string, readonly string[]>> = {
  ballad: ['simple'],
  edm: ['edmSimple', 'edmComplex'],
  latin: ['latin'],
  brightPop: ['simple', 'brightPop'],
  organicVibes: ['simple', 'organicVibes'],
  rock: ['rock'],
  schlager: ['edmSimple', 'edmComplex'],
  urban: ['urban'],
};

/**
 * Roll the legacy style for `genre` and dispatch to its real generator.
 * Returns `null` for a style whose generator is not yet ported (urban →
 * HipHop, phase 3), signalling the caller to use the SM bank fallback.
 *
 * Busyness is rolled internally only where the legacy generator uses it
 * (SimpleBass); ballad is forced to busyness 1 (controllers/patterns.js).
 */
export function selectRealBassPattern(
  rng: Rng,
  genre: string,
  scale: ScaleMode,
): RealBassSelection | null {
  const styles = LEGACY_BASS_GENRE_STYLES[genre];
  if (!styles || styles.length === 0) return null;
  const style = styles.length === 1 ? styles[0]! : rng.pick(styles);
  switch (style) {
    case 'simple':
      return selectSimpleBassPattern(rng, genre === 'ballad' ? 1 : rng.pick([1, 2, 3] as const));
    case 'edmSimple':
      return selectEdmSimpleBassPattern(rng);
    case 'edmComplex':
    case 'latin':
    case 'brightPop':
    case 'organicVibes':
    case 'rock':
      return selectCenteredBankPattern(rng, style, scale);
    case 'urban':
    default:
      return null; // HipHop not yet ported — caller falls back to SM bank.
  }
}
