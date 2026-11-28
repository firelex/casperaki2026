// The singing plan of "Sing" (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md, "Who sings what"):
// every vocal is sung by SoulX-Singer, the recipe of the owner's approved demo (owner's decision 2026-11-25: "I want
// the same recipe as in the demo track"). Every section with notes in the Vocal lane (and written lyrics) is sung
// straight from the lane's notes, words and phonemes at the lane's own pitch; the backing lines are the song's
// "Backing vocals 1" and "Backing vocals 2" lanes in those sections, each moved by whole octaves into the singable
// range near the lead (`backingShift`), sung by re-pitching the section's lead take to them.
//
// Pure: reads the song only.

import { generatedSections, generatorParams, sungSections, vocalMelodyShown } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

/** A failure the user sees as the Sing task's reason. */
export class SingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingError';
  }
}

export const LEAD_TRACK = 'Vocal';
export const BACKING_TRACKS = ['Backing vocals 1', 'Backing vocals 2'] as const;
const BEATS_PER_BAR = 4;
/** Every sung backing note must lie within F3..A5. */
const LOWEST_SUNG = 53;
const HIGHEST_SUNG = 81;

/** A note of the Vocal lane as SoulX sings it: beats from the section start, the lane's pitch, its word and phonemes. */
export interface SungNote {
  readonly start: number;
  readonly duration: number;
  readonly midi: number;
  readonly word: string;
  readonly phonemes: readonly string[];
}

/** A backing line's note: beats from the section start, the pitch it is sung at. */
export interface BackingNote {
  readonly start: number;
  readonly duration: number;
  readonly midi: number;
}

export interface SingPlan {
  /** Every sung section in song order, with the Vocal lane's notes (the melody sung, kept exactly as written). */
  /** `restAfter`: beats from the section's end to the next sung note of the song, the least over every place its take
   *  is played (its reuses), null when nothing is sung after any of them; the singer sings the section's last phrase
   *  into that rest (owner, 2026-11-27: "space", the bridge's last note, was cut off at the bar line). */
  readonly sections: { segment: string; sectionBars: number; restAfter: number | null; notes: SungNote[] }[];
  /** Every backing lane with notes in a sung section: its notes moved by `shift` semitones (`backingShift`). */
  readonly backings: { track: string; segment: string; shift: number; notes: BackingNote[] }[];
  /** Sections sung exactly as an earlier one (same length, the same Vocal notes with the same words, the same backing
   *  lines): not sung again, `from`'s takes are reused (owner, 2026-11-25: one chorus is enough when the words are the
   *  same). `sections` and `backings` leave them out. */
  readonly reuses: { segment: string; from: string }[];
}

type LaneEvent = { type?: string; note: number; duration: number; fullWord?: string; vocaloidPhonemes?: string[] };

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

function laneEvents(song: Song, segment: string, track: string): { start: number; key: string; barIndex: number; e: LaneEvent }[] {
  const bars = (song.arrangement[segment]?.overrides?.[track]?.bars ?? []) as unknown as readonly { notes?: Record<string, readonly unknown[] | undefined> }[];
  const out: { start: number; key: string; barIndex: number; e: LaneEvent }[] = [];
  bars.forEach((bar, barIndex) => {
    for (const [key, evs] of Object.entries(bar.notes ?? {})) {
      for (const e of (evs ?? []) as LaneEvent[]) {
        if (e.type === 'vocalNote') out.push({ start: barIndex * BEATS_PER_BAR + Number.parseFloat(key), key, barIndex, e });
      }
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

/** A lane's vocal notes in a section with their words and phonemes (beats from the section start); a note without
 *  either is a SingError ("write lyrics first"). */
export function laneNotes(song: Song, segment: string, track: string): SungNote[] {
  return laneEvents(song, segment, track).map(({ start, key, barIndex, e }) => {
    const where = `${track} in ${segment} bar ${barIndex + 1} beat ${key}`;
    if (!e.fullWord) throw new SingError(`${where}: a note without a word: write lyrics first`);
    if (!e.vocaloidPhonemes || e.vocaloidPhonemes.length === 0) throw new SingError(`${where}: a note without phonemes: write lyrics first`);
    return { start, duration: e.duration, midi: e.note, word: e.fullWord, phonemes: [...e.vocaloidPhonemes] };
  });
}

/** A lane's vocal notes in a section, pitch and timing only (backing lanes carry the lead's words, not their own). */
function lanePitches(song: Song, segment: string, track: string): BackingNote[] {
  return laneEvents(song, segment, track).map(({ start, e }) => ({ start, duration: e.duration, midi: e.note }));
}

/**
 * Throws SingError naming the first of `sections` (working-song names) that the song as its generator makes it does
 * not have by that name and bar count: a section renamed, added, duplicated or resized in the editor. The sung melody
 * and the written lyrics are recorded by the generator's section names and replayed through it, so such a section
 * cannot be sung (or transcribed) into the song.
 */
export function checkSectionsGenerated(song: Song, sections: readonly string[]): void {
  const generated = generatedSections(generatorParams(song));
  for (const name of sections) {
    const own = song.songStructure.find((s) => s.name === name);
    if (!own) throw new Error(`checkSectionsGenerated: the song has no section "${name}"`);
    const gen = generated.find((s) => s.name === name);
    if (!gen) {
      throw new SingError(`The section ${name} was added or renamed in the editor, so it cannot be sung: only sections as the song was generated can be`);
    }
    if (gen.bars !== own.bars.length) {
      throw new SingError(
        `The section ${name} has ${own.bars.length} bars, but ${gen.bars} as the song was generated (resized in the editor), so it cannot be sung`,
      );
    }
  }
}

const median = (xs: readonly number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length / 2;
  return v.length % 2 ? v[Math.floor(mid)]! : (v[mid - 1]! + v[mid]!) / 2;
};

/** Whole-octave shifts a backing line may take, lowest first (a tie goes to the lower). */
const BACKING_SHIFTS = [-24, -12, 0, 12, 24] as const;

/**
 * A backing line's own octave (semitones added to its lane notes): the shift whose median note is nearest the lead's
 * median in the same section, among shifts that keep every note of the line within F3..A5; a tie goes to the lower
 * shift. No shift fits → SingError naming the line (`where`: "<track> in <section>") and its range.
 */
export function backingShift(line: readonly number[], lead: readonly number[], where: string): number {
  if (line.length === 0) throw new Error(`${where}: a backing line without notes`);
  if (lead.length === 0) throw new Error(`${where}: no lead in the section to place the backing line against`);
  const lo = Math.min(...line);
  const hi = Math.max(...line);
  const leadMedian = median(lead);
  const lineMedian = median(line);
  let best: number | undefined;
  for (const d of BACKING_SHIFTS) {
    if (lo + d < LOWEST_SUNG || hi + d > HIGHEST_SUNG) continue;
    if (best === undefined || Math.abs(lineMedian + d - leadMedian) < Math.abs(lineMedian + best - leadMedian)) best = d;
  }
  if (best === undefined) {
    throw new SingError(
      `${where} spans ${noteName(lo)}-${noteName(hi)}, which no octave shift puts within the singable range ${noteName(LOWEST_SUNG)}-${noteName(HIGHEST_SUNG)}`,
    );
  }
  return best;
}

/** Who sings what (see the file comment): every section with a melody, or only those of `only` (the sections the
 *  user chose). Throws SingError without a melody, for a chosen section that has none, without written lyrics for every sung
 *  section, with a sung section the generator does not make (`checkSectionsGenerated`), or with a backing line no
 *  octave puts in the singable range. */
export function planSinging(song: Song, only?: readonly string[]): SingPlan {
  const all = vocalMelodyShown(song) ? sungSections(song) : [];
  if (all.length === 0) throw new SingError('Write a melody first');
  if (only !== undefined) {
    if (only.length === 0) throw new SingError('Choose a section to sing');
    const missing = only.filter((n) => !all.some((s) => s.name === n));
    if (missing.length) throw new SingError(`${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no melody to sing`);
  }
  const sung = only === undefined ? all : all.filter((s) => only.includes(s.name));
  checkSectionsGenerated(
    song,
    sung.map((s) => s.name),
  );
  // Read raw: writtenLyricsOf's schema rejects an empty line list with its own error, and an empty list means the
  // section has no written words ("Write lyrics first").
  const lyrics = (generatorParams(song).params?.['lyrics'] ?? {}) as Readonly<Record<string, readonly unknown[] | undefined>>;
  if (sung.some((s) => !lyrics[s.name]?.length)) throw new SingError('Write lyrics first');

  // Beats from each sung section's end to the next sung note (null: none after).
  const structure = song.songStructure;
  // The rest after a section runs to the next section with a melody, sung now or not.
  const sungNames = new Set(all.map((s) => s.name));
  const restAfterOf = (name: string): number | null => {
    let beats = 0;
    for (const next of structure.slice(structure.findIndex((x) => x.name === name) + 1)) {
      const first = sungNames.has(next.name) ? laneNotes(song, next.name, LEAD_TRACK)[0] : undefined;
      if (first) return beats + first.start;
      beats += next.bars.length * 4;
    }
    return null;
  };
  const least = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
  const sections: SingPlan['sections'] = [];
  const backings: SingPlan['backings'] = [];
  const reuses: SingPlan['reuses'] = [];
  const sungAs = new Map<string, string>(); // what a section sings (its key) -> the first section that sings it
  for (const s of sung) {
    const own = song.songStructure.find((x) => x.name === s.name)!;
    const notes = laneNotes(song, s.name, LEAD_TRACK);
    const lines: SingPlan['backings'] = [];
    for (const track of BACKING_TRACKS) {
      const line = lanePitches(song, s.name, track);
      if (line.length === 0) continue;
      const shift = backingShift(
        line.map((n) => n.midi),
        notes.map((n) => n.midi),
        `${track} in ${s.name}`,
      );
      lines.push({ track, segment: s.name, shift, notes: line.map((n) => ({ ...n, midi: n.midi + shift })) });
    }
    const key = JSON.stringify([own.bars.length, notes, lines.map((l) => [l.track, l.notes])]);
    const first = sungAs.get(key);
    if (first !== undefined) {
      reuses.push({ segment: s.name, from: first });
      const i = sections.findIndex((x) => x.segment === first);
      sections[i] = { ...sections[i]!, restAfter: least(sections[i]!.restAfter, restAfterOf(s.name)) };
      continue;
    }
    sungAs.set(key, s.name);
    sections.push({ segment: s.name, sectionBars: own.bars.length, restAfter: restAfterOf(s.name), notes });
    backings.push(...lines);
  }
  return { sections, backings, reuses };
}
