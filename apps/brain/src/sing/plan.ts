// The singing plan of "Sing" (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md, "Who sings what"):
// which sections YuE2 sings (the lead stage's units), which reuse a unit's take, which SoulX copies to a unit's sung
// melody, which extra bars of a longer copy get a YuE2 unit of their own, and which choruses get ad-libs. Also the
// song's octave shift and YuE2's style text, the copy rule (`followSung`) and the ad-lib gap bars (`adlibGapBars`),
// which the sing task uses to assemble the second (repeats) stage once the lead is sung.
//
// Pure: reads the song only. Notes are in the Vocal lane's register throughout; `octave` says how far above the lane
// the song is sung.

import { generatorParams, lyricLines, sungSections, vocalMelodyShown } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

/** A failure the user sees as the Sing task's reason. */
export class SingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingError';
  }
}

const LEAD_TRACK = 'Vocal';
const BEATS_PER_BAR = 4;
/** Bars of the preceding chords YuE2 hears before a unit, and of the following chords after it (no singing). */
const LEAD_BARS = 2;
const TAIL_BARS = 2;
const EPS = 1e-6;
/** The sung lead's median note aims at B4; every sung note must lie within F3..A5. */
const TARGET_MIDI = 71;
const LOWEST_SUNG = 53;
const HIGHEST_SUNG = 81;
/** Tried highest first, so a tie goes to the higher shift. */
const OCTAVES = [12, 0, -12] as const;
export type Octave = (typeof OCTAVES)[number];

/** YuE2's style text per genre (the song's genre in words, then the voice). */
const GENRE_STYLE: Readonly<Record<string, string>> = {
  ballad: 'Pop ballad, emotional, piano',
  brightPop: 'Pop, bright, upbeat',
  edm: 'EDM, dance pop, energetic',
  latin: 'Latin pop, rhythmic, percussive',
  organicVibes: 'Acoustic pop, organic, warm',
  rock: 'Pop rock, electric guitars, driving',
  schlager: 'Schlager, German pop, catchy',
  urban: 'R&B, hip hop, smooth',
};

/** A section (or the extra bars of one) for YuE2 to sing: the lead stage's unit, as its params take it. */
export interface LeadUnit {
  readonly id: string;
  /** Chords per beat of the LEAD_BARS bars before the unit. */
  readonly lead_in_chords: string[];
  /** Chords per beat of the unit's bars. */
  readonly chords: string[];
  /** Chords per beat of the TAIL_BARS bars after the section (the song's last section: its own last 2 bars). */
  readonly tail_chords: string[];
  /** One note per syllable position (held "-" positions included), beats from the unit's first bar, lane register. */
  readonly notes: { start: number; duration: number; midi: number }[];
  /** The sung words, one text line per lyric line. */
  readonly lyrics: string[];
  /** Syllables (fullWord convention: "Un-" continues) per lyric line. */
  readonly words: string[][];
  /** Vocaloid phonemes per syllable per lyric line. */
  readonly phonemes: string[][][];
}

export interface SingPlan {
  /** Semitones above the Vocal lane the song is sung at. */
  readonly octave: Octave;
  /** YuE2's style text. */
  readonly style: string;
  /** YuE2 units in song order: the first section of each type, and the extra bars of longer copies. */
  readonly units: LeadUnit[];
  /** Later sections of a type with other words: SoulX sings the unit's sung melody (`followSung`) for the first
   *  `sungBars` bars (min of the section's and the unit's bar counts; not the section's length — the repeats stage's
   *  `section_bars` is that). */
  readonly copies: { segment: string; from: string; sungBars: number }[];
  /** Later sections the same as their type's unit (words, melody, chords, bars): they play its take. */
  readonly reuses: { segment: string; from: string }[];
  /** A copy longer than its unit: YuE2 unit `unit` sings bars `fromBar`.. of `segment`. */
  readonly extensions: { segment: string; unit: string; fromBar: number }[];
  /** Choruses that get ad-libs: the second half of the song's choruses (indices floor(n/2)..n-1). */
  readonly adlibChoruses: string[];
}

/** A note as sung and transcribed (lead.json's SungNote): lane register, beats from the section start. */
export interface SungNote {
  readonly start: number;
  readonly duration: number;
  readonly midi: number;
  readonly word: string;
  readonly phonemes: readonly string[];
}

type VocalEvent = { type?: string; note: number; duration: number; fullWord?: string; vocaloidPhonemes?: string[] };
type LaneBars = readonly { readonly notes?: Readonly<Record<string, readonly unknown[] | undefined>> }[];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/** YuE2's style text for a genre id. */
export function styleFor(genre: string): string {
  const words = GENRE_STYLE[genre];
  if (!words) throw new SingError(`Sing does not know the genre "${genre}"`);
  return `${words}, female lead vocal`;
}

function laneBars(song: Song, name: string): LaneBars {
  return (song.arrangement[name]?.overrides?.[LEAD_TRACK]?.bars ?? []) as unknown as LaneBars;
}

function vocalEvents(bars: LaneBars): VocalEvent[] {
  return bars.flatMap((bar) => Object.values(bar.notes ?? {}).flatMap((evs) => (evs ?? []) as VocalEvent[])).filter((e) => e.type === 'vocalNote');
}

function eventAt(bars: LaneBars, barIndex: number, beat: number, where: string): VocalEvent {
  for (const [key, evs] of Object.entries(bars[barIndex]?.notes ?? {})) {
    if (Math.abs(Number.parseFloat(key) - beat) > EPS) continue;
    const ev = ((evs ?? []) as VocalEvent[]).find((e) => e.type === 'vocalNote');
    if (ev) return ev;
  }
  throw new Error(`${where}: no vocal note at bar ${barIndex + 1} beat ${beat}`);
}

/** The words of a lyric line as text: continued syllables joined, held "-" positions left out. */
function lineText(syllables: readonly string[]): string {
  let text = '';
  for (const s of syllables) {
    if (s === '-') continue;
    text += s.endsWith('-') ? s.slice(0, -1) : `${s} `;
  }
  return text.trim();
}

/** The song's octave shift as Sing chooses it (over every sung section's Vocal lane): see `octaveOf`. A SingError
 *  without a melody, or when no shift fits. */
export function songOctave(song: Song): Octave {
  const sung = vocalMelodyShown(song) ? sungSections(song) : [];
  return octaveOf(
    song,
    sung.map((s) => s.name),
  );
}

/** The song's octave shift: the one whose sung median is nearest B4 with every note within F3..A5. */
function octaveOf(song: Song, sections: readonly string[]): Octave {
  const notes = sections.flatMap((name) => vocalEvents(laneBars(song, name)).map((e) => e.note)).sort((a, b) => a - b);
  if (notes.length === 0) throw new SingError('Write a melody first');
  const mid = notes.length / 2;
  const median = notes.length % 2 ? notes[Math.floor(mid)]! : (notes[mid - 1]! + notes[mid]!) / 2;
  const lo = notes[0]!;
  const hi = notes[notes.length - 1]!;
  let best: Octave | undefined;
  for (const shift of OCTAVES) {
    if (lo + shift < LOWEST_SUNG || hi + shift > HIGHEST_SUNG) continue;
    if (best === undefined || Math.abs(median + shift - TARGET_MIDI) < Math.abs(median + best - TARGET_MIDI)) best = shift;
  }
  if (best === undefined) {
    throw new SingError(
      `The melody spans ${noteName(lo)}-${noteName(hi)}, which no octave shift puts within the singable range ${noteName(LOWEST_SUNG)}-${noteName(HIGHEST_SUNG)}`,
    );
  }
  return best;
}

function barChords(chords: readonly string[], where: string): string[] {
  if (chords.length !== BEATS_PER_BAR) throw new Error(`${where}: a bar has ${chords.length} chords, want one per beat (${BEATS_PER_BAR})`);
  return [...chords];
}

/** A YuE2 unit for bars `fromBar`.. of section `segIndex`. */
function unitOf(song: Song, segIndex: number, fromBar: number, id: string): LeadUnit {
  const seg = song.songStructure[segIndex]!;
  const all = song.songStructure.flatMap((s) => s.bars.map((b, i) => barChords(b.chords, `${s.name} bar ${i + 1}`)));
  const offset = song.songStructure.slice(0, segIndex).reduce((n, s) => n + s.bars.length, 0);
  const first = offset + fromBar;
  if (first < LEAD_BARS) throw new SingError(`${id}: the song has fewer than ${LEAD_BARS} bars before it for the singer's lead-in`);
  const end = offset + seg.bars.length;
  let tail = all.slice(end, end + TAIL_BARS);
  if (tail.length < TAIL_BARS) {
    // the song's last section: its own last bars stand in for the chords that would follow
    if (seg.bars.length < TAIL_BARS) throw new SingError(`${id}: the song ends with a section shorter than ${TAIL_BARS} bars`);
    tail = all.slice(end - TAIL_BARS, end);
  }
  const bars = laneBars(song, seg.name);
  const notes: LeadUnit['notes'] = [];
  const words: string[][] = [];
  const phonemes: string[][][] = [];
  for (const line of lyricLines(bars)) {
    const slots = line.filter((s) => s.barIndex >= fromBar);
    if (slots.length === 0) continue;
    const w: string[] = [];
    const p: string[][] = [];
    for (const slot of slots) {
      const where = `${seg.name} bar ${slot.barIndex + 1} beat ${slot.beat}`;
      const ev = eventAt(bars, slot.barIndex, slot.beat, seg.name);
      if (!ev.fullWord) throw new SingError(`${where}: a note without a word: write lyrics first`);
      if (!ev.vocaloidPhonemes || ev.vocaloidPhonemes.length === 0) throw new SingError(`${where}: a note without phonemes: write lyrics first`);
      notes.push({ start: slot.start - fromBar * BEATS_PER_BAR, duration: slot.duration, midi: ev.note });
      w.push(ev.fullWord);
      p.push([...ev.vocaloidPhonemes]);
    }
    words.push(w);
    phonemes.push(p);
  }
  return {
    id,
    lead_in_chords: all.slice(first - LEAD_BARS, first).flat(),
    chords: all.slice(first, end).flat(),
    tail_chords: tail.flat(),
    notes,
    lyrics: words.map(lineText),
    words,
    phonemes,
  };
}

/** What makes a later section play its unit's take: the same bars, chords, notes and words. */
function signature(song: Song, name: string): string {
  const seg = song.songStructure.find((s) => s.name === name)!;
  const bars = laneBars(song, name);
  const lane = lyricLines(bars).flat().map((s) => {
    const ev = eventAt(bars, s.barIndex, s.beat, name);
    return [s.start, s.duration, ev.note, ev.fullWord ?? '', ev.vocaloidPhonemes ?? []];
  });
  return JSON.stringify({ chords: seg.bars.map((b) => b.chords), lane });
}

/** Who sings what (see the file comment). Throws SingError without a melody or written lyrics for every sung section. */
export function planSinging(song: Song): SingPlan {
  const sung = vocalMelodyShown(song) ? sungSections(song) : [];
  if (sung.length === 0) throw new SingError('Write a melody first');
  // Read raw: writtenLyricsOf's schema rejects an empty line list with its own error, and an empty list means the
  // section has no written words ("Write lyrics first").
  const lyrics = (generatorParams(song).params?.['lyrics'] ?? {}) as Readonly<Record<string, readonly unknown[] | undefined>>;
  if (sung.some((s) => !lyrics[s.name]?.length)) throw new SingError('Write lyrics first');

  const index = new Map(song.songStructure.map((s, i) => [s.name, i] as const));
  const barsOf = (name: string) => song.songStructure[index.get(name)!]!.bars.length;
  const units: LeadUnit[] = [];
  const copies: SingPlan['copies'] = [];
  const reuses: SingPlan['reuses'] = [];
  const extensions: SingPlan['extensions'] = [];
  const firstOfType = new Map<string, string>();
  for (const s of sung) {
    const from = firstOfType.get(s.type);
    if (from === undefined) {
      firstOfType.set(s.type, s.name);
      units.push(unitOf(song, index.get(s.name)!, 0, s.name));
      continue;
    }
    if (signature(song, s.name) === signature(song, from)) {
      reuses.push({ segment: s.name, from });
      continue;
    }
    const own = barsOf(s.name);
    const theirs = barsOf(from);
    copies.push({ segment: s.name, from, sungBars: Math.min(own, theirs) });
    if (own > theirs && vocalEvents(laneBars(song, s.name).slice(theirs)).length > 0) {
      const id = `${s.name}_ext`;
      units.push(unitOf(song, index.get(s.name)!, theirs, id));
      extensions.push({ segment: s.name, unit: id, fromBar: theirs });
    }
  }
  const choruses = sung.filter((s) => s.type === 'chorus').map((s) => s.name);
  const octave = octaveOf(
    song,
    sung.map((s) => s.name),
  );
  if (!song.genre) throw new SingError('The song has no genre');
  return {
    octave,
    style: styleFor(song.genre),
    units,
    copies,
    reuses,
    extensions,
    adlibChoruses: choruses.slice(Math.floor(choruses.length / 2)),
  };
}

/**
 * The copy rule: a copied section's notes on its unit's sung melody. Each target note takes the sung note of the
 * source position at or before it (the same melody; a note the lyrics split off takes its parent's pitch, offset by
 * the same beats) and lasts until the next note or its parent's sung end. The target keeps its words and phonemes.
 * `source`: the unit's lane notes, one per position; `sung`: lead.json's melody of the unit (the same positions).
 */
export function followSung(
  target: readonly SungNote[],
  source: readonly { start: number }[],
  sung: readonly SungNote[],
  name: string,
): SungNote[] {
  if (source.length !== sung.length) throw new Error(`${name}: the sung melody has ${sung.length} notes for ${source.length} positions of its unit`);
  const out = [...target]
    .sort((a, b) => a.start - b.start)
    .map((t) => {
      let i = -1;
      source.forEach((q, j) => {
        if (q.start <= t.start + EPS) i = j;
      });
      if (i < 0) throw new Error(`${name}: a note at beat ${t.start} comes before the first note of the section it copies`);
      const s = sung[i]!;
      return { t, start: s.start + (t.start - source[i]!.start), end: s.start + s.duration, midi: s.midi };
    });
  out.forEach((a, k) => {
    const b = out[k + 1];
    if (b) a.end = Math.min(a.end, b.start);
  });
  return out.map(({ t, start, end, midi }) => ({
    start,
    duration: Math.max(0.25, Math.round((end - start) * 4) / 4),
    midi,
    word: t.word,
    phonemes: [...t.phonemes],
  }));
}

/** The bars (0-based) of a section where the sung lead leaves room for ad-libs: two beats or more with no syllable
 *  starting (a rest, or a held note). */
export function adlibGapBars(melody: readonly SungNote[], bars: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    const a = b * BEATS_PER_BAR;
    const z = a + BEATS_PER_BAR;
    const points = [a, ...melody.map((n) => n.start).filter((t) => t >= a - EPS && t < z - EPS).sort((x, y) => x - y), z];
    if (points.some((p, k) => k > 0 && p - points[k - 1]! >= 2 - EPS)) out.push(b);
  }
  return out;
}
