import { describe, expect, it } from 'vitest';

import { addNote, deleteNote, keptBars, moveNote, resizeNote, setChord, setChords, startEdit, undo, TOTAL_BEATS } from '../../src/hum/melodyEdit';

const chords = Array.from({ length: 16 }, () => 'C');
const base = () =>
  startEdit(
    [
      { beat: 0, midi: 60, duration: 1 },
      { beat: 3, midi: 62, duration: 1 },
      { beat: 4, midi: 64, duration: 2 },
    ],
    chords,
  );

describe('melodyEdit', () => {
  it('adds a note on the 16th grid', () => {
    const e = addNote(base(), 1.1, 67, 1);
    expect(e.melody.map((n) => n.beat)).toEqual([0, 1, 3, 4]);
    expect(e.melody[1]).toEqual({ beat: 1, midi: 67, duration: 1 });
    expect([...e.editedBars]).toEqual([0]);
  });

  it('refuses to add inside a note', () => {
    const e0 = base();
    expect(addNote(e0, 0.5, 70, 1)).toBe(e0);
  });

  it('cuts a new note at the next note', () => {
    const e = addNote(base(), 1, 67, 4);
    expect(e.melody[1]).toEqual({ beat: 1, midi: 67, duration: 2 });
  });

  it('keeps a moved note inside the 8 bars', () => {
    const e = moveNote(base(), 2, 31.5, 64);
    const n = e.melody.find((x) => x.midi === 64)!;
    expect(n.beat + n.duration).toBeLessThanOrEqual(TOTAL_BEATS);
    expect(n.beat).toBe(30);
    const back = moveNote(base(), 0, -3, 60);
    expect(back.melody[0]!.beat).toBe(0);
  });

  it('refuses a move onto another note', () => {
    const e0 = base();
    expect(moveNote(e0, 0, 3.5, 60)).toBe(e0);
  });

  it('resizes on the grid, at least a 16th, up to the next note', () => {
    expect(resizeNote(base(), 0, 0.1).melody[0]!.duration).toBe(0.25);
    expect(resizeNote(base(), 0, 10).melody[0]!.duration).toBe(3);
    expect(resizeNote(base(), 2, 100).melody[2]!.duration).toBe(TOTAL_BEATS - 4);
  });

  it('marks the bars a moved note leaves and enters', () => {
    const e = moveNote(base(), 2, 16, 64); // from bar 2 to bar 5 (1-based)
    expect([...e.editedBars].sort()).toEqual([1, 4]);
  });

  it('does not mark bars when only a chord changes', () => {
    const e = setChord(base(), 9, 'Am');
    expect(e.chords[9]).toBe('Am');
    expect(e.editedBars.size).toBe(0);
    expect(setChords(e, chords).chords[9]).toBe('C');
  });

  it('keeps the hummed bars and the edited ones', () => {
    const e = moveNote(base(), 2, 20, 64);
    expect(keptBars(e, 2)).toEqual([0, 1, 5]);
  });

  it('undoes', () => {
    const e0 = base();
    const e = undo(addNote(e0, 1, 67, 1));
    expect(e.melody).toEqual(e0.melody);
    expect(e.editedBars.size).toBe(0);
    expect(undo(e0)).toBe(e0);
  });

  it('can delete every note', () => {
    let e = base();
    while (e.melody.length) e = deleteNote(e, 0);
    expect(e.melody).toEqual([]);
    expect([...e.editedBars].sort()).toEqual([0, 1]);
  });
});
