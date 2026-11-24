// Casperaki hooks: original 8-bar melodies with chords, written as text and turned into entries of the vocal
// precedent bank format (precedents.ts), checked on the way. See docs/superpowers/specs/2026-11-24-hook-library-design.md.
//
// One hook:
//
//   hook: Rising Call                      a name of our own
//   type: Chorus                           Verse | Pre-chorus | Chorus | Bridge
//   tempo: 90-130                          bpm range the hook suits
//   feel: anthem                           a short tag for the library's filter
//   leadin: yes                            optional: a lead-in bar before the 8 bars (default no)
//   chords: C | G | Am F | F G C G | ...   per bar: 1, 2 (half bars) or 4 (beats) symbols, in C (minor: A minor)
//   melody: e4:1 g4:1 c5:2 | b4:4- |       sung pitch (C4 = middle C) : length in beats; r:<beats> is a rest;
//           b4:2 r:2 | ...                 a trailing "-" ties into the next note (same pitch); "|" must fall on a bar
//                                          line; the melody may continue on the following lines.
//
// The bank's register is an octave below sung pitch (the legacy banks write midi 48 as "c4"), so midi = sung - 12.
// Pure (no I/O): scripts/build-hooks.mjs reads the text files and writes the bank.

import { QUALITY_INTERVALS, parseChordSymbol, type Chord } from '../hum/chords.js';
import type { Precedent } from './precedents.js';

export interface HookEntry {
  readonly id: string;
  readonly properties: {
    readonly name: string;
    readonly originalKey: 'C';
    readonly key: 'C';
    readonly tempo: string;
    readonly busyness: number;
    readonly type: HookType;
    readonly start: 0 | 1;
    readonly end: 8 | 9;
    readonly lowestNote: number;
    readonly highestNote: number;
    readonly medianNote: number;
    readonly kind: 'hook';
    readonly tempoMin: number;
    readonly tempoMax: number;
    readonly feel: string;
    readonly useOriginal: true;
    readonly useRemix: true;
    readonly source: { readonly kind: 'casperaki' };
  };
  readonly melody: Record<string, { note: string; midi: number; duration: number }[]>;
  readonly chords: Record<string, { chord: string }>;
}

export type HookType = 'Verse' | 'Pre-chorus' | 'Chorus' | 'Bridge';
const TYPES: readonly HookType[] = ['Verse', 'Pre-chorus', 'Chorus', 'Bridge'];

/** Sung range every hook stays inside, and its widest span (a 12th). */
export const SUNG_LOW = 55; // G3
export const SUNG_HIGH = 79; // G5
const MAX_SPAN = 19;
/** Share of notes starting on beats 1 and 3 that must be chord tones. */
const STRONG_CHORD_TONES = 0.7;
/** Notes outside C major (and outside their chord) allowed per hook. */
const MAX_CHROMATIC = 2;
/** Leaps wider than a major sixth allowed per hook. */
const MAX_BIG_LEAPS = 2;
const BIG_LEAP = 9;

const LETTER: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] as const;
const SUNG_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);

const sungName = (m: number) => `${SUNG_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
const beatKey = (b: number) => (Number.isInteger(b) ? b.toFixed(1) : String(b));
const pcsOf = (c: Chord) => new Set(QUALITY_INTERVALS[c.q].map((i) => (c.deg + i) % 12));

interface SungNote {
  beat: number;
  midi: number;
  duration: number;
}

function parseMelody(text: string, totalBeats: number, err: (m: string) => void): SungNote[] {
  const notes: SungNote[] = [];
  let pos = 0;
  let tieFrom: SungNote | undefined;
  for (const tok of text.split(/\s+/u).filter(Boolean)) {
    if (tok === '|') {
      if (pos % 4 !== 0) err(`a barline at beat ${pos}, which is not the end of a bar`);
      continue;
    }
    const m = /^(r|[a-g][#b]?\d):(\d+(?:\.\d+)?)(-?)$/u.exec(tok);
    if (!m) {
      err(`cannot read "${tok}" (write a pitch and length like e4:1 or c#5:0.5, r:2 for a rest, | for a barline)`);
      continue;
    }
    const duration = Number(m[2]);
    if (duration <= 0 || Math.abs(duration * 4 - Math.round(duration * 4)) > 1e-9) err(`"${tok}": lengths are multiples of 0.25 beats`);
    if (m[1] === 'r') {
      if (tieFrom) err(`"${tok}": a tie must go to a note of the same pitch, not a rest`);
      tieFrom = undefined;
      if (m[3]) err(`"${tok}": a rest cannot be tied`);
      pos += duration;
      continue;
    }
    const p = /^([a-g])([#b]?)(\d)$/u.exec(m[1]!)!;
    const midi = 12 * (Number(p[3]) + 1) + LETTER[p[1]!]! + (p[2] === '#' ? 1 : p[2] === 'b' ? -1 : 0);
    if (tieFrom) {
      if (tieFrom.midi !== midi) err(`"${tok}": tied from ${sungName(tieFrom.midi)}, so it must be the same pitch`);
      tieFrom.duration += duration;
    } else notes.push({ beat: pos, midi, duration });
    const current = tieFrom ?? notes[notes.length - 1]!;
    tieFrom = m[3] ? current : undefined;
    pos += duration;
  }
  if (tieFrom) err('the last note is tied to nothing');
  if (Math.abs(pos - totalBeats) > 1e-9) err(`the melody is ${pos} beats, not ${totalBeats}`);
  return notes;
}

function parseChords(text: string, bars: number, err: (m: string) => void): (Chord & { symbol: string })[] {
  const perBeat: (Chord & { symbol: string })[] = [];
  const barTexts = text.split('|').map((b) => b.trim());
  if (barTexts.length !== bars) err(`${barTexts.length} bars of chords, not ${bars}`);
  for (const b of barTexts) {
    const syms = b.split(/\s+/u).filter(Boolean);
    if (![1, 2, 4].includes(syms.length)) {
      err(`a bar of chords has ${syms.length} chords ("${b}"); use 1, 2 or 4`);
      continue;
    }
    for (const s of syms) {
      let c: Chord;
      try {
        c = parseChordSymbol(s, 0);
      } catch (e) {
        err(`chord "${s}": ${e instanceof Error ? e.message : String(e)}`);
        c = { deg: 0, q: 'maj' };
      }
      for (let i = 0; i < 4 / syms.length; i++) perBeat.push({ ...c, symbol: s });
    }
  }
  return perBeat;
}

/** Check a melody against its chords and the key; returns what is wrong, in words. */
function checkMusic(notes: readonly SungNote[], chords: readonly (Chord & { symbol: string })[], startBeat: number): string[] {
  const out: string[] = [];
  const chordAt = (beat: number) => chords[Math.min(chords.length - 1, Math.floor(beat))]!;
  const isChordTone = (n: SungNote) => pcsOf(chordAt(n.beat)).has(n.midi % 12);
  const strong = notes.filter((n) => n.beat >= startBeat && (n.beat % 4 === 0 || n.beat % 4 === 2));
  const good = strong.filter(isChordTone).length;
  if (strong.length && good / strong.length < STRONG_CHORD_TONES) {
    out.push(`only ${good} of ${strong.length} notes on strong beats (1 and 3) are chord tones; at least ${Math.round(STRONG_CHORD_TONES * 100)}% must be`);
  }
  const chromatic = notes.filter((n) => !C_MAJOR.has(n.midi % 12) && !isChordTone(n));
  if (chromatic.length > MAX_CHROMATIC) out.push(`${chromatic.length} notes are outside the key and their chord (${chromatic.map((n) => sungName(n.midi)).join(', ')}); at most ${MAX_CHROMATIC}`);
  let leaps = 0;
  for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i]!.midi - notes[i - 1]!.midi) > BIG_LEAP) leaps++;
  if (leaps > MAX_BIG_LEAPS) out.push(`${leaps} leaps wider than a major sixth; at most ${MAX_BIG_LEAPS}`);
  const last = notes[notes.length - 1];
  if (last && (!isChordTone(last) || last.duration < 1)) out.push(`does not end on a chord tone held at least a beat (ends on ${sungName(last.midi)} for ${last.duration})`);
  const lo = Math.min(...notes.map((n) => n.midi));
  const hi = Math.max(...notes.map((n) => n.midi));
  if (lo < SUNG_LOW) out.push(`${sungName(lo)} is below ${sungName(SUNG_LOW)}, the lowest note a hook may use`);
  if (hi > SUNG_HIGH) out.push(`${sungName(hi)} is above ${sungName(SUNG_HIGH)}, the highest note a hook may use`);
  if (hi - lo > MAX_SPAN) out.push(`spans ${hi - lo} semitones (${sungName(lo)}-${sungName(hi)}); at most a 12th (${MAX_SPAN})`);
  return out;
}

/** Hooks in `text` as bank entries (ids `<prefix>-01`, …), and every problem found, each naming its hook. */
export function parseHookText(text: string, prefix: string): { hooks: HookEntry[]; errors: string[] } {
  const errors: string[] = [];
  const hooks: HookEntry[] = [];
  const blocks: Record<string, string>[] = [];
  let cur: Record<string, string> | undefined;
  let lastKey = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/u, '');
    if (!line.trim()) continue;
    const kv = /^(\w+):\s*(.*)$/u.exec(line.trim());
    if (kv && /^\S/u.test(line) && ['hook', 'type', 'tempo', 'feel', 'leadin', 'chords', 'melody'].includes(kv[1]!)) {
      if (kv[1] === 'hook') blocks.push((cur = {}));
      if (!cur) {
        errors.push(`"${line.trim()}" comes before the first "hook:" line`);
        continue;
      }
      cur[kv[1]!] = kv[2]!;
      lastKey = kv[1]!;
    } else if (cur && /^\s/u.test(raw) && (lastKey === 'melody' || lastKey === 'chords')) {
      cur[lastKey] += ` ${line.trim()}`;
    } else errors.push(`cannot read the line "${line.trim()}"`);
  }
  const seen = new Map<string, string>();
  blocks.forEach((b, i) => {
    const name = b['hook']?.trim() || `hook ${i + 1}`;
    const err = (m: string) => errors.push(`${prefix} "${name}": ${m}`);
    for (const k of ['type', 'tempo', 'feel', 'chords', 'melody']) if (!b[k]?.trim()) err(`"${k}:" is missing`);
    const type = b['type']?.trim() as HookType;
    if (b['type'] && !TYPES.includes(type)) err(`type "${b['type']}" is not one of ${TYPES.join(', ')}`);
    const tm = /^(\d+)\s*-\s*(\d+)$/u.exec(b['tempo']?.trim() ?? '');
    if (b['tempo'] && (!tm || Number(tm[1]) >= Number(tm[2]))) err(`tempo "${b['tempo']}" must be a range like 90-130`);
    const leadin = (b['leadin'] ?? 'no').trim();
    if (!['yes', 'no'].includes(leadin)) err(`leadin must be yes or no, not "${leadin}"`);
    if (!b['chords'] || !b['melody'] || !tm) return;
    const bars = leadin === 'yes' ? 9 : 8;
    const before = errors.length;
    const chords = parseChords(b['chords'], bars, err);
    const notes = parseMelody(b['melody'], bars * 4, err);
    if (notes.length === 0) err('the melody has no notes');
    if (errors.length > before) return;
    for (const m of checkMusic(notes, chords, leadin === 'yes' ? 4 : 0)) err(m);
    const sig = notes.map((n) => `${n.beat}:${n.midi}:${n.duration}`).join(' ');
    const twin = seen.get(sig);
    if (twin) err(`the same melody as "${twin}"`);
    seen.set(sig, name);
    if (errors.length > before) return;
    const bank = notes.map((n) => ({ ...n, midi: n.midi - 12 }));
    const sorted = bank.map((n) => n.midi).sort((x, y) => x - y);
    const melody: HookEntry['melody'] = {};
    for (const n of bank) melody[beatKey(n.beat)] = [{ note: `${NAMES[n.midi % 12]}${Math.floor(n.midi / 12)}`, midi: n.midi, duration: n.duration }];
    const chordMap: HookEntry['chords'] = {};
    chords.forEach((c, beat) => (chordMap[beatKey(beat)] = { chord: c.symbol }));
    hooks.push({
      id: `${prefix}-${String(hooks.length + 1).padStart(2, '0')}`,
      properties: {
        name, originalKey: 'C', key: 'C', tempo: String(Math.round((Number(tm[1]) + Number(tm[2])) / 2)),
        busyness: bank.length / 8, type, start: leadin === 'yes' ? 1 : 0, end: leadin === 'yes' ? 9 : 8,
        lowestNote: sorted[0]!, highestNote: sorted[sorted.length - 1]!, medianNote: sorted[Math.floor(sorted.length / 2)]!,
        kind: 'hook', tempoMin: Number(tm[1]), tempoMax: Number(tm[2]), feel: b['feel']!.trim(),
        useOriginal: true, useRemix: true, source: { kind: 'casperaki' },
      },
      melody,
      chords: chordMap,
    });
  });
  return { hooks, errors };
}

// ---- bank-format entries: checks, rebuilding from notes ----

/** Statistics of a bank melody, as the hook builder writes them: busyness = notes / 8, lowest, highest and median
 *  (upper median) midi. */
export function melodyStats(melody: Precedent['melody']): { busyness: number; lowestNote: number; highestNote: number; medianNote: number } {
  const sorted = Object.values(melody).map((n) => n[0]!.midi).sort((x, y) => x - y);
  if (sorted.length === 0) throw new Error('melodyStats: the melody has no notes');
  return {
    busyness: sorted.length / 8,
    lowestNote: sorted[0]!,
    highestNote: sorted[sorted.length - 1]!,
    medianNote: sorted[Math.floor(sorted.length / 2)]!,
  };
}

/** A copy of `base` with its melody and chords rebuilt from notes (bank register: midi 48 is "c4") and one chord
 *  symbol per half bar (`(end) * 2` of them, lead-in bar included), and the melody statistics recomputed as the
 *  hook builder does. Every other property is kept. Throws when the chord count does not match. */
export function precedentEntryFromNotes(
  base: Precedent,
  notes: readonly { beat: number; midi: number; duration: number }[],
  halfBarChords: readonly string[],
): Precedent {
  const halfBars = base.properties.end * 2;
  if (halfBarChords.length !== halfBars) {
    throw new Error(`precedentEntryFromNotes: ${halfBarChords.length} half-bar chords, but the entry has ${halfBars} half bars (end ${base.properties.end})`);
  }
  const melody: Precedent['melody'] = {};
  for (const n of [...notes].sort((a, b) => a.beat - b.beat)) {
    melody[beatKey(n.beat)] = [{ note: `${NAMES[n.midi % 12]}${Math.floor(n.midi / 12)}`, midi: n.midi, duration: n.duration }];
  }
  const chords: Precedent['chords'] = {};
  for (let beat = 0; beat < base.properties.end * 4; beat++) chords[beatKey(beat)] = { chord: halfBarChords[Math.floor(beat / 2)]! };
  return { ...base, properties: { ...base.properties, ...melodyStats(melody) }, melody, chords };
}

/** What is wrong with a bank entry, in words ([] = fine). Both kinds: notes on the 16th grid (quarter beats) from
 *  0 and ending by the entry's end (end * 4 beats; a lead-in bar counts), one note per beat, no overlapping notes,
 *  every chord readable and on a whole beat inside the entry. "hook" (our own entries) also needs a chord on every
 *  beat and gets the musical checks hooks are written to (chord tones on strong beats, notes in the key, leaps,
 *  ending, range, span). "legacy" entries were not written to those rules and may have no chords (the rhythmic
 *  banks), so they get the mechanical checks only. */
export function checkPrecedentEntry(entry: Precedent, kind: 'hook' | 'legacy'): string[] {
  const out: string[] = [];
  const { start, end } = entry.properties;
  const totalBeats = end * 4;
  const onGrid = (x: number) => Math.abs(x * 4 - Math.round(x * 4)) < 1e-9;

  const notes: SungNote[] = [];
  for (const [key, list] of Object.entries(entry.melody)) {
    const beat = Number(key);
    if (!Number.isFinite(beat)) {
      out.push(`melody beat "${key}" is not a number`);
      continue;
    }
    if (list.length !== 1) out.push(`beat ${beat} has ${list.length} notes; one note per beat`);
    const n = list[0];
    if (!n) continue;
    if (beat < 0 || !onGrid(beat)) out.push(`the note at beat ${beat} is not on the 16th grid from 0`);
    if (!(n.duration > 0) || !onGrid(n.duration)) out.push(`the note at beat ${beat} lasts ${n.duration} beats; lengths are positive multiples of 0.25`);
    if (beat + n.duration > totalBeats + 1e-9) out.push(`the note at beat ${beat} ends at beat ${beat + n.duration}, after the end (${totalBeats} beats)`);
    notes.push({ beat, midi: n.midi + 12, duration: n.duration });
  }
  notes.sort((a, b) => a.beat - b.beat);
  if (notes.length === 0) out.push('the melody has no notes');
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1]!;
    if (prev.beat + prev.duration > notes[i]!.beat + 1e-9) {
      out.push(`the note at beat ${prev.beat} (${prev.duration} beats) overlaps the note at beat ${notes[i]!.beat}`);
    }
  }

  for (const [key, c] of Object.entries(entry.chords)) {
    const beat = Number(key);
    if (!Number.isInteger(beat) || beat < 0 || beat >= totalBeats) out.push(`a chord at beat "${key}", outside the whole beats 0..${totalBeats - 1}`);
    try {
      parseChordSymbol(c.chord, 0);
    } catch (e) {
      out.push(`chord "${c.chord}" at beat ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (kind === 'legacy') return out;

  const chords: (Chord & { symbol: string })[] = [];
  for (let beat = 0; beat < totalBeats; beat++) {
    const c = entry.chords[beatKey(beat)];
    if (!c) out.push(`no chord at beat ${beat}`);
    else {
      try {
        chords.push({ ...parseChordSymbol(c.chord, 0), symbol: c.chord });
      } catch {
        // already reported above
      }
    }
  }
  if (out.length === 0) out.push(...checkMusic(notes, chords, start * 4));
  return out;
}
