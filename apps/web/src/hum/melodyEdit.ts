/**
 * The hum editor's rules for one version's melody and chords (pure, so it can be tested):
 * 8 bars of 4 beats, a 16th-note grid, one voice (notes never overlap), everything inside the 8 bars.
 * Each change returns a new edit with the previous state on `history` (for undo); a change that breaks a rule
 * returns the edit unchanged. Bars whose melody the user touched are in `editedBars` (0-based): a new completion
 * keeps them. Chord changes do not mark bars.
 */
import type { BeatNote } from '../api/hum';

export const TOTAL_BEATS = 32;
export const GRID = 0.25;

interface State {
  readonly melody: readonly BeatNote[];
  readonly chords: readonly string[];
  readonly editedBars: ReadonlySet<number>;
}

export interface VersionEdit extends State {
  readonly history: readonly State[];
}

const snapDown = (x: number) => Math.floor(x / GRID + 1e-9) * GRID;
const snap = (x: number) => Math.round(x / GRID) * GRID;
const barOf = (beat: number) => Math.floor(beat / 4);
/** The bars a note sounds in. */
const barsOf = (n: BeatNote): number[] => {
  const out: number[] = [];
  for (let b = barOf(n.beat); b * 4 < n.beat + n.duration - 1e-9; b++) out.push(b);
  return out;
};
const overlaps = (a: BeatNote, b: BeatNote) => a.beat < b.beat + b.duration - 1e-9 && b.beat < a.beat + a.duration - 1e-9;
const byBeat = (a: BeatNote, b: BeatNote) => a.beat - b.beat;

export function startEdit(melody: readonly BeatNote[], chords: readonly string[]): VersionEdit {
  return { melody: [...melody].sort(byBeat), chords: [...chords], editedBars: new Set(), history: [] };
}

function commit(e: VersionEdit, next: Partial<State>, touched: readonly BeatNote[] = []): VersionEdit {
  const editedBars = new Set(e.editedBars);
  for (const n of touched) for (const b of barsOf(n)) editedBars.add(b);
  const prev: State = { melody: e.melody, chords: e.chords, editedBars: e.editedBars };
  return {
    melody: next.melody ? [...next.melody].sort(byBeat) : e.melody,
    chords: next.chords ?? e.chords,
    editedBars,
    history: [...e.history, prev],
  };
}

/** Where the note starting at `beat` must end: the next note's start, or the end of bar 8. */
function limitAfter(melody: readonly BeatNote[], beat: number, skip?: number): number {
  let end = TOTAL_BEATS;
  melody.forEach((n, i) => {
    if (i !== skip && n.beat > beat + 1e-9) end = Math.min(end, n.beat);
  });
  return end;
}

/**
 * Add a note. Where another note is sounding at that moment (one voice), it is cut short there, or replaced when the
 * new note starts where it starts; clicking inside a note of the same pitch changes nothing.
 */
export function addNote(e: VersionEdit, beat: number, midi: number, length: number): VersionEdit {
  const start = Math.max(0, Math.min(TOTAL_BEATS - GRID, snapDown(beat)));
  const covering = e.melody.findIndex((n) => overlaps(n, { beat: start, midi, duration: GRID }));
  const hit = covering >= 0 ? e.melody[covering]! : undefined;
  if (hit && hit.midi === midi) return e;
  const rest = hit
    ? hit.beat === start
      ? e.melody.filter((_, i) => i !== covering)
      : e.melody.map((n, i) => (i === covering ? { ...n, duration: start - n.beat } : n))
    : e.melody;
  const duration = Math.min(Math.max(GRID, snap(length)), limitAfter(rest, start) - start);
  const note = { beat: start, midi, duration };
  return commit(e, { melody: [...rest, note] }, hit ? [note, hit] : [note]);
}

export function deleteNote(e: VersionEdit, index: number): VersionEdit {
  const n = e.melody[index];
  if (!n) return e;
  return commit(e, { melody: e.melody.filter((_, i) => i !== index) }, [n]);
}

export function moveNote(e: VersionEdit, index: number, beat: number, midi: number): VersionEdit {
  const n = e.melody[index];
  if (!n) return e;
  const start = Math.max(0, Math.min(TOTAL_BEATS - n.duration, snap(beat)));
  const moved = { beat: start, midi, duration: n.duration };
  if (e.melody.some((m, i) => i !== index && overlaps(m, moved))) return e;
  if (moved.beat === n.beat && moved.midi === n.midi) return e;
  return commit(e, { melody: e.melody.map((m, i) => (i === index ? moved : m)) }, [n, moved]);
}

export function resizeNote(e: VersionEdit, index: number, length: number): VersionEdit {
  const n = e.melody[index];
  if (!n) return e;
  const duration = Math.min(Math.max(GRID, snap(length)), limitAfter(e.melody, n.beat, index) - n.beat);
  if (duration === n.duration) return e;
  const sized = { ...n, duration };
  return commit(e, { melody: e.melody.map((m, i) => (i === index ? sized : m)) }, [n, sized]);
}

export function setChord(e: VersionEdit, slot: number, chord: string): VersionEdit {
  if (slot < 0 || slot >= e.chords.length || e.chords[slot] === chord) return e;
  return commit(e, { chords: e.chords.map((c, i) => (i === slot ? chord : c)) });
}

export function setChords(e: VersionEdit, chords: readonly string[]): VersionEdit {
  return commit(e, { chords: [...chords] });
}

/** A new completion: the melody replaced, the edited bars kept as they are (they came back unchanged). */
export function setMelody(e: VersionEdit, melody: readonly BeatNote[]): VersionEdit {
  return commit(e, { melody });
}

export function undo(e: VersionEdit): VersionEdit {
  const prev = e.history[e.history.length - 1];
  if (!prev) return e;
  return { ...prev, history: e.history.slice(0, -1) };
}

/** Bars a new completion must keep: the hummed bars and every bar the user edited, ascending. */
export function keptBars(e: VersionEdit, hummedBars: number): number[] {
  const s = new Set(e.editedBars);
  for (let b = 0; b < hummedBars; b++) s.add(b);
  return [...s].sort((a, b) => a - b);
}
